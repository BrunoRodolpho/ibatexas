// ops-conductor.ts — the OPS conductor plane (NEW-032 slice B).
//
// A SECOND @claustrum/core Conductor composed per-request from the SAME
// production ports as the chat conductor — the proven second-conductor idiom of
// live-agent-conductor.ts (H1). The two deliberate divergences are:
//   - the PLANNER carries `staffEnvelopeActor` (stamps every envelope's actor as
//     `admin:<staffId>` + role → the dormant staffRoleGuard becomes a LIVE gate)
//     and the ops `deriveContext`/persona/read executors;
//   - the RESOLVER is the per-request ops resolver (per-kind SystemState); the
//     tool registry is the ops registry (governed ops verbs only); channels is
//     [systemChannel]. Every other port is shared VERBATIM.
//
// `createConductor` binds planner/responder/tools/channels at compose time, so a
// per-request identity (staffId+role) requires a per-request recomposition — the
// cheap, proven H1 idiom (no boot side effects run in this path). `composeOps
// Conductor` is a STANDALONE dependency-injected function (like
// composeLiveAgentConductor) so the crown-jewel proof can drive a full
// handleTurn with fakes + the REAL composed router + REAL kernel — no bootstrap.

import {
  createConductor,
  type Adjudicator,
  type ChannelDriver,
  type CognitiveState,
  type Conductor,
  type ExplainerPort,
  type GroundingPort,
  type HandoffPort,
  type MemoryPort,
  type ModelProvider,
  type ResolverPort,
  type SessionLock,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
  type ToolRegistry,
} from "@claustrum/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import { opsCapabilityPlanner } from "@ibatexas/pack-ops";
import {
  createIbatexasPlanner,
  type StaffEnvelopeActor,
} from "../claustrum/ibatexas-planner.js";
import { createIbatexasResponder } from "../claustrum/ibatexas-responder.js";
import type { IbatexasPromptComposer } from "../claustrum/prompts/ibatexas-prompts.js";
import type { ScheduleSignal } from "../claustrum/closed-hours.js";
import {
  OPS_PLANNER_PERSONA,
  OPS_RESPONDER_GROUNDED_PERSONA_PTBR,
  OPS_RESPONDER_PERSONA_PTBR,
} from "../claustrum/prompts/personas.js";
import { resolvePrompt } from "../claustrum/prompts/prompt-overrides.js";
import {
  readToolRosterDrift,
  toolRosterDrift,
  ROSTER_DRIFT_CONTEXTS,
  type RosterDriftContext,
  type ToolDefinition,
} from "../tools/register-ibatexas-tool-packs.js";
import {
  clampUngroundedOpsFact,
  governGroundedOpsDraft,
  renderOpsReadAnswer,
  OPS_READ_RENDER_TEMPLATE_KEYS,
  OPS_UNGROUNDED_CLAMP_PTBR,
  type CapturedOpsRead,
} from "./ops-read-render.js";
import { renderOpsActionAnswer } from "./ops-action-render.js";
import { deriveOpsPlannerContext } from "./ops-planner-context.js";
import { composeOpsPlannerSystem } from "./ops-history.js";
import {
  excludedKindsForScope,
  forbiddenOpsVerbProblems,
  scopeCapabilityPlanner,
  scopeResumeChannel,
  type OpsVerbScope,
} from "./ops-verb-scope.js";

/** A per-turn read-tool executor (mirrors the chat planner's map). */
export type OpsReadToolExecutor = (
  input: unknown,
  state: CognitiveState,
) => Promise<unknown>;

/**
 * Per-request context threaded into a composition (BKL-084). `historyBlock` is a
 * pre-rendered, DATA-fenced pt-BR conversation-history block appended to the
 * planner system prompt so anaphora ("e o brisket?") can resolve. It is prompt
 * CONTEXT only — never parsed into an envelope payload.
 */
export interface OpsConductorContext {
  readonly historyBlock?: string;
  /**
   * The ingress that composed this conductor (BKL-086). Selects the verb scope:
   * `"whatsapp"` deterministically excludes irreversible money / two-person verbs
   * (the SIM-swap compensating control — see {@link OpsVerbScope} and
   * `ops-verb-scope.ts`) from BOTH the advertised/allowlisted intents AND the
   * confirm-resume matcher. Absent ⇒ `"dashboard"` (excludes nothing —
   * byte-identical to the pre-BKL-086 composition).
   */
  readonly opsVerbScope?: OpsVerbScope;
}

/**
 * The shared production ports the ops plane reuses verbatim, PLUS the ingredients
 * `composeOpsConductor` needs to recompose the per-request planner/responder/
 * resolver. Mirrors {@link LiveAgentConductorDeps} in shape/intent.
 */
export interface OpsConductorDeps {
  readonly adjudicator: Adjudicator;
  readonly memory: MemoryPort;
  readonly grounding: GroundingPort;
  readonly explainer: ExplainerPort;
  readonly handoff: HandoffPort;
  readonly telemetry: TelemetryPort;
  readonly session: SessionPort;
  readonly tenantResolver: TenantResolver;
  readonly sessionLock: SessionLock;
  /** The non-conversational ingress driver (channel "system"). */
  readonly systemChannel: ChannelDriver;
  /** The OPS tool registry (governed ops verbs) — built ONCE at boot. */
  readonly tools: ToolRegistry;
  /** The chat/synthesis model provider (shared singleton). */
  readonly model: ModelProvider;
  readonly modelId: string;
  readonly promptComposer?: IbatexasPromptComposer;
  readonly resolveScheduleSignal?: () =>
    | Promise<ScheduleSignal | undefined>
    | ScheduleSignal
    | undefined;
  /** Planner one-hop read executors — `{ ops_snapshot: ... }`. */
  readonly opsReadToolExecutors: Readonly<Record<string, OpsReadToolExecutor>>;
  /** Build the per-request ops resolver closing over the authenticated staffId. */
  readonly buildResolver: (staffId: string) => ResolverPort;
}

/**
 * Compose the OPS conductor for ONE staff turn. `actor` = the authenticated
 * `{ staffId, role }` captured from the JWT at ingress — the SAME constant the
 * planner stamps onto every envelope's `actor` and the deriver/resolver close
 * over, so willingness-to-propose, envelope authority, and resolved state can
 * never diverge. Nothing the model emits influences it.
 */
export function composeOpsConductor(
  deps: OpsConductorDeps,
  actor: StaffEnvelopeActor,
  context: OpsConductorContext = {},
): Conductor {
  // BKL-086 — the ingress verb scope. `dashboard` (the default) excludes
  // nothing, so both filters below are identity and the composition is
  // byte-identical to the pre-BKL-086 shape. `whatsapp` excludes the irreversible
  // money / two-person verbs (the SIM-swap compensating control).
  const excludedKinds = excludedKindsForScope(context.opsVerbScope ?? "dashboard");

  // BKL-100 — the per-request read-capture buffer. `composeOpsConductor` runs once
  // per staff turn, so this buffer is turn-scoped; the wrapped executors record
  // each read's result/error keyed on the executor's `state.turnId`, and the
  // responder's `readAnswer.render(turnId)` reads it back for the SAME turn. The
  // wrapper RETHROWS on failure so the planner's `Promise.allSettled` enrichment
  // behaviour is byte-unchanged (the capture is a pure side-record).
  const captures: CapturedOpsRead[] = [];
  const capturingReadExecutors = wrapOpsReadExecutorsWithCapture(
    deps.opsReadToolExecutors,
    captures,
  );

  const planner = createIbatexasPlanner({
    model: deps.model,
    modelId: deps.modelId,
    capabilityPlanners: [
      scopeCapabilityPlanner(
        opsCapabilityPlanner as CapabilityPlanner<unknown, unknown>,
        excludedKinds,
      ),
    ],
    deriveContext: deriveOpsPlannerContext(actor.staffId),
    staffEnvelopeActor: { staffId: actor.staffId, role: actor.role },
    readToolExecutors: capturingReadExecutors,
    // The staff-facing ops persona is the WHOLE system prompt (bypasses the
    // customer fragment graph); telemetry still emits the planner LLMTrace. The
    // per-request history block (if any) trails the persona as fenced DATA.
    system: composeOpsPlannerSystem(
      resolvePrompt("ops/planner.persona", OPS_PLANNER_PERSONA),
      context.historyBlock,
    ),
    telemetry: deps.telemetry,
    ...(deps.promptComposer ? { promptComposer: deps.promptComposer } : {}),
    ...(deps.resolveScheduleSignal
      ? { resolveScheduleSignal: deps.resolveScheduleSignal }
      : {}),
  });

  const responder = createIbatexasResponder({
    model: deps.model,
    modelId: deps.modelId,
    explainer: deps.explainer,
    telemetry: deps.telemetry,
    ...(deps.promptComposer ? { promptComposer: deps.promptComposer } : {}),
    ...(deps.resolveScheduleSignal
      ? { resolveScheduleSignal: deps.resolveScheduleSignal }
      : {}),
    // Staff-facing personas WIN over the composer (see IbatexasResponderDeps);
    // ESCALATE reuses the default handoff line (no ops override).
    personas: {
      conversational: resolvePrompt("ops/responder.persona", OPS_RESPONDER_PERSONA_PTBR),
      grounded: resolvePrompt("ops/responder.grounded", OPS_RESPONDER_GROUNDED_PERSONA_PTBR),
    },
    // BKL-100 — the ops read-answer governor. `render` deterministically renders a
    // captured staff read (no model call, no authored number); `clampUngrounded`
    // demotes an ungrounded domain number in the conversational fallback. Keyed on
    // the turnId shared by the planner's read executors and this responder's
    // `input.cognition.turnId`.
    readAnswer: {
      render: (turnId: string) => renderOpsReadAnswer(captures, turnId),
      // BKL-149 — the deterministic mutation-success render. On a COMMITTED ops
      // EXECUTE/REWRITE turn the statement of WHAT THE VERB DID is rendered from
      // the adjudicated envelope (kind + resolved payload) + dispatch result, never
      // authored by the model (closes the 377ca7a1 falsehood class on the action
      // plane — the ACTION analog of `render` for reads). `undefined` when nothing
      // committed (deferred / failed) → the responder keeps its honest grounded
      // path. A MIXED read+act turn appends the deterministic read render (the read
      // half must come from the ACTUAL captured read, never the model), mirroring
      // `governGrounded`.
      renderAction: (acted: unknown, turnId: string) => {
        const action = renderOpsActionAnswer(acted);
        if (action === undefined) return undefined;
        const read = renderOpsReadAnswer(captures, turnId);
        return read === undefined ? action : `${action}\n\n${read}`;
      },
      clampUngrounded: clampUngroundedOpsFact,
      // Adversarial-review fix — the grounded (EXECUTE/REWRITE/DEFER) branch:
      // append the deterministic render of any read captured this turn + digit-run
      // clamp ungrounded model numbers. Fail-HONEST: an internal throw yields the
      // nudge, never the ungoverned model draft (fail-open would silently restore
      // the exact hole this closes).
      governGrounded: (
        text: string,
        turnId: string,
        allowedSources: readonly string[],
      ) => {
        try {
          return governGroundedOpsDraft(text, captures, turnId, allowedSources);
        } catch {
          return OPS_UNGROUNDED_CLAMP_PTBR;
        }
      },
    },
  });

  return createConductor({
    adjudicator: deps.adjudicator,
    memory: deps.memory,
    grounding: deps.grounding,
    planner,
    responder,
    explainer: deps.explainer,
    handoff: deps.handoff,
    telemetry: deps.telemetry,
    session: deps.session,
    tools: deps.tools,
    // BKL-086 defense in depth: on the WhatsApp scope, an out-of-scope parked
    // envelope (e.g. a dashboard-parked refund) is invisible to matchToParked,
    // so "sim" over WhatsApp can never resume it. `dashboard` ⇒ the driver
    // unchanged.
    channels: [scopeResumeChannel(deps.systemChannel, excludedKinds)],
    tenantResolver: deps.tenantResolver,
    sessionLock: deps.sessionLock,
    resolver: deps.buildResolver(actor.staffId),
  });
}

/**
 * Wrap each ops read executor so a run records a {@link CapturedOpsRead} into the
 * per-request buffer, keyed on the executor's `state.turnId` (BKL-100). A success
 * records `{name, turnId, result}`; a throw records `{name, turnId, error}` and
 * RETHROWS — so the planner's one-hop enrichment `Promise.allSettled` sees the
 * EXACT same fulfilled/rejected outcome it did before (the capture is a pure side
 * record). The wrapped map preserves the executor KEYS exactly (and therefore the
 * advertised-read set the drift gate probes).
 */
function wrapOpsReadExecutorsWithCapture(
  executors: Readonly<Record<string, OpsReadToolExecutor>>,
  captures: CapturedOpsRead[],
): Readonly<Record<string, OpsReadToolExecutor>> {
  const wrapped: Record<string, OpsReadToolExecutor> = {};
  for (const [name, execute] of Object.entries(executors)) {
    wrapped[name] = async (input, state) => {
      const turnId = state.turnId;
      try {
        const result = await execute(input, state);
        captures.push({ name, turnId, result });
        return result;
      } catch (error) {
        captures.push({ name, turnId, error });
        throw error; // planner allSettled behaviour unchanged
      }
    };
  }
  return wrapped;
}

/**
 * Boot-time ops-plane drift parity (fail-closed like toolRosterDrift /
 * readToolRosterDrift): assert every ops-registry tool is composed-router-
 * routable (its intentKind is owned by an installed pack ⇔ policyForKind
 * non-null) with `capability === intentKind`, AND every ops-advertised read has
 * a registered executor. Reuses the chat gates' helpers over the OPS registry +
 * `opsCapabilityPlanner`. Returns human-readable problems; empty = healthy.
 */
export function opsPlaneDriftProblems(input: {
  /** The ops registry's tool definitions. */
  readonly opsTools: ReadonlyArray<ToolDefinition<unknown, unknown>>;
  /** The union of installed-pack intent kinds (composedIntentKinds()). */
  readonly composedIntentKinds: ReadonlyArray<string>;
  /** The ops read-executor keys (Object.keys(opsReadToolExecutors)). */
  readonly readExecutorKeys: ReadonlyArray<string>;
  /**
   * The read names that have a deterministic render template (BKL-100). Defaults
   * to the real `OPS_READ_RENDER_TEMPLATE_KEYS`; overridable so a test can prove
   * the advertised⊆renderable gate fails on a missing template.
   */
  readonly renderableReadKeys?: ReadonlyArray<string>;
  /** Probe contexts (defaults to the shared ROSTER_DRIFT_CONTEXTS). */
  readonly contexts?: ReadonlyArray<RosterDriftContext>;
  readonly onWarn?: (message: string) => void;
}): string[] {
  const opsPlanners = [
    opsCapabilityPlanner as CapabilityPlanner<unknown, unknown>,
  ];
  const onWarn = input.onWarn ?? (() => {});
  const problems: string[] = [];
  // Mutating verbs: capability===intentKind + routable (kind ∈ composed union) +
  // advertised⊆registered per probe.
  problems.push(
    ...toolRosterDrift(input.opsTools, input.composedIntentKinds, {
      planners: opsPlanners,
      ...(input.contexts ? { contexts: input.contexts } : {}),
      onWarn,
    }),
  );
  // Advertised reads must all have an executor (the ops_snapshot read).
  problems.push(
    ...readToolRosterDrift(opsPlanners, input.readExecutorKeys, {
      ...(input.contexts ? { contexts: input.contexts } : {}),
      onWarn,
    }),
  );
  // BKL-096 — defense in depth: fail boot CLOSED if a FORBIDDEN two-person
  // destructive verb (order.cancel / payment.waive / payment.status.force) ever
  // enters the ops REGISTRY. Today none is registered here NOR matrixed (two
  // independent fail-closed layers), so this check is inert on the real 8-verb
  // roster; it makes the exclusion EXPLICIT so a future PR that registers one as
  // an ops tool trips this gate rather than silently exposing it. The persona's
  // advertised SURFACE (planner allowlist, both ingress scopes) is pinned by the
  // BKL-096 drift test — see FORBIDDEN_OPS_DESTRUCTIVE_KINDS. Extracted to
  // `forbiddenOpsVerbProblems` (ops-verb-scope.ts, FE-T24 review fix) so a
  // freshness test can drive this SAME real check with a generated forbidden
  // set — the default parameter here is byte-identical to the pre-extraction
  // inline loop.
  problems.push(...forbiddenOpsVerbProblems(input.opsTools));
  // BKL-100 — advertised ⊆ renderable: every ops read the planner advertises MUST
  // have a deterministic render template (ops-read-render.ts), else a staff read
  // turn would fall back to model-authored prose — the exact confabulation this
  // work removes. Probe the ops planner under the shared drift contexts (the
  // `staff` probe is where both reads are advertised) and assert each advertised
  // read name is a renderable template key.
  const renderable = new Set(
    input.renderableReadKeys ?? OPS_READ_RENDER_TEMPLATE_KEYS,
  );
  const driftContexts = input.contexts ?? ROSTER_DRIFT_CONTEXTS;
  const advertisedReads = new Set<string>();
  for (const probe of driftContexts) {
    for (const planner of opsPlanners) {
      for (const read of planner.plan(probe.state, probe.context).visibleReadTools) {
        advertisedReads.add(read);
      }
    }
  }
  for (const read of advertisedReads) {
    if (!renderable.has(read)) {
      problems.push(
        `ops-advertised read "${read}" has no deterministic render template ` +
          `(ops-read-render.ts) — a staff read turn would fall back to ` +
          `model-authored prose (BKL-100). Add a template + its key to ` +
          `OPS_READ_RENDER_TEMPLATE_KEYS.`,
      );
    }
  }
  return problems;
}
