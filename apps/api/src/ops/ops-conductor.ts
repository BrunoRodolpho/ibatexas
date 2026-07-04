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
import {
  readToolRosterDrift,
  toolRosterDrift,
  type RosterDriftContext,
  type ToolDefinition,
} from "../tools/register-ibatexas-tool-packs.js";
import { deriveOpsPlannerContext } from "./ops-planner-context.js";
import { composeOpsPlannerSystem } from "./ops-history.js";
import {
  excludedKindsForScope,
  FORBIDDEN_OPS_DESTRUCTIVE_KINDS,
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
    readToolExecutors: deps.opsReadToolExecutors,
    // The staff-facing ops persona is the WHOLE system prompt (bypasses the
    // customer fragment graph); telemetry still emits the planner LLMTrace. The
    // per-request history block (if any) trails the persona as fenced DATA.
    system: composeOpsPlannerSystem(OPS_PLANNER_PERSONA, context.historyBlock),
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
      conversational: OPS_RESPONDER_PERSONA_PTBR,
      grounded: OPS_RESPONDER_GROUNDED_PERSONA_PTBR,
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
  // independent fail-closed layers), so this loop is inert on the real 7-verb
  // roster; it makes the exclusion EXPLICIT so a future PR that registers one as
  // an ops tool trips this gate rather than silently exposing it. The persona's
  // advertised SURFACE (planner allowlist, both ingress scopes) is pinned by the
  // BKL-096 drift test — see FORBIDDEN_OPS_DESTRUCTIVE_KINDS.
  for (const tool of input.opsTools) {
    const capability = String(tool.capability);
    const intentKind = String(tool.intentKind);
    if (
      FORBIDDEN_OPS_DESTRUCTIVE_KINDS.has(capability) ||
      FORBIDDEN_OPS_DESTRUCTIVE_KINDS.has(intentKind)
    ) {
      problems.push(
        `ops registry advertises FORBIDDEN two-person destructive verb ` +
          `"${capability}" (tool ${tool.id}); these verbs must stay ops-unreachable ` +
          `until an owner ratifies a propose-path (OPS-007/008/011). See ` +
          `FORBIDDEN_OPS_DESTRUCTIVE_KINDS.`,
      );
    }
  }
  return problems;
}
