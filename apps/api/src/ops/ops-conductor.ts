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
import {
  buildClaimsSeams,
  claimsPipelineEnabled,
  warnOncePerMessage,
} from "../claustrum/claims-pipeline.js";
import { createIbatexasClaimsRenderPrecedence } from "../claustrum/claims-renderer-adapter.js";
import { createSafeUnknownGate } from "../claustrum/safe-unknown-gate.js";
import { logger } from "../lib/logger.js";
import type { IbatexasPromptComposer } from "../claustrum/prompts/ibatexas-prompts.js";
import type { ScheduleSignal } from "../claustrum/closed-hours.js";
import {
  OPS_CLAIM_PLANNER_PERSONA,
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
import {
  OPS_CLAIM_SCOPE,
  OPS_PLANE_VALIDATED_TEMPLATES,
  assertOpsClaimDefinitionRegistryValid,
} from "./ops-claim-registry.js";
import { createOpsClaimTurnReads } from "./ops-claim-reads.js";

/**
 * LE2 decision 6 — `composeOpsConductor` runs PER STAFF TURN, so it must build the
 * claims seams per turn too (the claim-planner adapter wraps THAT turn's planner
 * instance — the Q6b "one planner, two surfaces" contract). `buildClaimsSeams`
 * emits its kernel-floor warning on every call, and the linked kernel versions do
 * not change between turns, so those repeats are pure log noise. De-dupe BY MESSAGE
 * exactly as the managed-agent plane's per-trigger factory does
 * (`buildClaimsSeamsForPlanner` in claustrum-bootstrap.ts): the closure lives at
 * MODULE scope so the dedup set spans the process, and every distinct warning still
 * gets its one line.
 */
const warnClaimsFloorOnce = warnOncePerMessage((message: string) =>
  logger.warn({ component: "ops-conductor" }, message),
);

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
    // Wire Truth — name the injected persona in the trace manifest so ops
    // planner rows stop reading `persona ?` in the workbench.
    systemPromptId: "ops/planner.persona",
    // LE2 decision 6 — the CLAIM path (`proposeClaims`, Q6b) needs the CLAIM-framed
    // persona, NOT the staff INTENT persona above: an intent persona suppresses the
    // `propose_claim` call on a 4B, so inheriting `system` here would make the
    // converged ops plane propose zero claims and silently fall back to prose.
    //
    // LE2-012 — the ops plane now carries its OWN claim-planner persona (the
    // skeleton composed the customer one and named this ticket as the reason it
    // would change). The job is identical (map ONE question to ONE registry TYPE,
    // author no value); the difference is the mapping guide, which must name the
    // ops-scoped types the ops enum below advertises — a customer persona would
    // leave the 4B with no tag for "quantos pedidos hoje?".
    claimPlannerSystem: resolvePrompt(
      "ops/claim-planner.persona",
      OPS_CLAIM_PLANNER_PERSONA,
    ),
    // LE2-012 — the OPS claim-type scope: the customer vocabulary PLUS the
    // store-level ops types. It is the `propose_claim` enum AND the schema every
    // deterministic wall parameterizes, so the ops planner can select an ops type
    // and the customer planner structurally cannot (the constrained-generation wall
    // IS the plane boundary — see ops-claim-registry.ts).
    claimScope: OPS_CLAIM_SCOPE,
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
    // Wire Truth — catalog ids for the overrides above (truthful single-tag
    // trace manifests instead of `[]`).
    personaIds: {
      conversational: "ops/responder.persona",
      grounded: "ops/responder.grounded",
    },
    // Wire Truth — ops REFUSE conversational recovery: a kernel-refused
    // proposed command (e.g. the BKL-233 hours-question misparse) synthesizes
    // a reply to the operator's actual message instead of dead-ending in the
    // canned refusal line; empty synthesis falls back to that line. Staff
    // plane only — customer refusals stay model-free by doctrine.
    conversationalRefusal: true,
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
    // LE2 decision 6 — the SAFE-UNKNOWN gate is now ACTIVE on the OPS responder.
    // BKL-078 D5 ("ops NEVER wires safeUnknown") is FORMALLY DISSOLVED by owner
    // decision: the ops plane's empty-plan branch was the last conversational
    // surface where a digit-free factual assertion could ship as raw model prose
    // (`clampUngroundedOpsFact` only demotes ungrounded NUMBERS). D5's premise was
    // that the deterministic `readAnswer.render` already covered staff reads — it
    // does, and it still runs FIRST (see ibatexas-responder.ts's REFUSE/empty-plan
    // branch): this gate is reached ONLY when no read was captured AND no claim
    // validated, i.e. exactly the prose fall-through. Small talk is untouched — the
    // discriminator never degrades a non-question (the BKL-110 0/15 bar).
    // The SAME `createSafeUnknownGate` the customer plane composes, minus the
    // customer-copy scheduled-pickup offer (see SafeUnknownGateOptions).
    // Flag-OFF → omitted → byte-identical to the pre-LE2 ops responder.
    //
    // LE2-013 — THE HOLE CLOSES. `retireRawProse` flips this plane's discriminator
    // from LE2-011's POSITIVE info-question net to its complement-of-smalltalk. The
    // skeleton's net could only degrade a turn it RECOGNISED as a question, so its
    // misses were still a live prose surface: an information-bearing staff turn with
    // no '?' and no WH/polar marker ("me passa o total de ontem", "o fornecedor
    // confirmou pra amanhã") ran the conversational completion, and the digit clamp
    // beneath it sees only NUMBERS. With the retirement the empty-plan FACTUAL path
    // terminates at the deterministic safe-unknown render ALWAYS, and raw prose
    // survives ONLY for small talk — the exact shape spec decision 6 ratifies. The
    // clamp is RETAINED beneath the gate as belt-and-suspenders (it is no longer the
    // primary defense; it now guards the surviving small-talk branch — see
    // `clampUngrounded` above and its LE2-013 turn-seam pin).
    ...(claimsPipelineEnabled()
      ? {
          safeUnknown: createSafeUnknownGate({
            closedHoursOffer: false,
            retireRawProse: true,
          }),
        }
      : {}),
  });

  // LE2 decision 6 (FULL convergence, no stopgap) — the OPS conductor gains the
  // SAME claims seams the customer conductor composes: investigator (first-party
  // turn reads → per-turn Evidence Ledger), claim planner (registry-constrained
  // candidates off THIS turn's planner), claims kernel (P1 soundness ∘ P2
  // consistency), and the render-from-claims template renderer. Nothing is forked:
  // `buildClaimsSeams` is the customer plane's own builder, parameterized only by
  // the per-request planner. It returns `{}` when ENABLE_CLAIMS_PIPELINE is OFF —
  // the SAME flag and the SAME reader the customer plane uses — so a flag-off ops
  // composition is a no-op spread and byte-identical to the pre-LE2 conductor.
  //
  // `info` is deliberately OMITTED (the BKL-108 boot marker is a boot-class fact;
  // this factory runs per turn) and so is `onSafetyEmergency` — both mirror the
  // managed-agent plane's per-trigger `buildClaimsSeamsForPlanner`. `warn` is the
  // module-scope de-duped sink (see {@link warnClaimsFloorOnce}).
  //
  // LE2-012 — the `plane` extension carries the ops-scoped claim TYPES the
  // skeleton deliberately left for this ticket: the scope (enum + schema), the
  // ops render templates, the ops resolvers, and the plane's own fail-closed
  // inv.18 registry assertion. Everything else is still `buildClaimsSeams`'s own
  // customer-plane construction, unforked.
  //
  // The resolvers take the RAW `deps.opsReadToolExecutors`, NOT the capture
  // wrapper above: the capture buffer records what the MODEL asked to read (and
  // drives lattice rule 3c), so routing the investigator's own deterministic ops
  // reads through it would make every ops-claim turn look like a BKL-100 read turn
  // and hand the reply back to the panorama render.
  const claimsSeams = buildClaimsSeams({
    planner,
    warn: warnClaimsFloorOnce,
    plane: {
      claimScope: OPS_CLAIM_SCOPE,
      templates: OPS_PLANE_VALIDATED_TEMPLATES,
      gatherReads: createOpsClaimTurnReads({ executors: deps.opsReadToolExecutors }),
      // The §O#15 customer companions do not apply to a STAFF actor who owns no
      // customer resources — see IbatexasClaimsRendererOptions.
      customerScopedCompanionsApply: false,
      assertRegistryValid: assertOpsClaimDefinitionRegistryValid,
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
    // LE2 decision 6 — the claims seams. `{}` when the flag is OFF (byte-identical).
    ...claimsSeams,
    // The render-vs-draft precedence, RE-BUILT for this plane. Same factory, same
    // pure lattice, same telemetry — plus the ops-only per-turn signal: a
    // DETERMINISTIC BKL-100 read render must not be clobbered by a DEGENERATE claims
    // render (lattice rule 3c). A genuinely VALIDATED claim still supersedes (rule
    // 3), which is what makes the store-open-now ops render land. `captures` is
    // turn-scoped by construction — `composeOpsConductor` is recomposed per staff
    // turn (see `getOpsConductorFactory`), which is the same contract the BKL-100
    // buffer above already relies on.
    ...(claimsSeams.claimsRenderPrecedence === undefined
      ? {}
      : {
          claimsRenderPrecedence: createIbatexasClaimsRenderPrecedence({
            plane: "ops",
            hasDeterministicReadRender: () => captures.length > 0,
          }),
        }),
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
  /**
   * The BKL-096 forbidden set to check the ops registry against, threaded
   * to `forbiddenOpsVerbProblems`.
   *
   * FE-4 CONTRACT (FE-T26): REQUIRED (was optional during FE-T25's repoint
   * window, defaulting through to the hand-authored `FORBIDDEN_OPS_
   * DESTRUCTIVE_KINDS`, now deleted). Every caller must now state its
   * intent explicitly. The real chat-registry boot call (`apps/api/src/
   * claustrum-bootstrap.ts`) supplies `generateOpsForbiddenDestructiveKinds
   * (CAPABILITY_DEFINITIONS)` from `@ibatexas/packs-composed/capability-
   * definitions` — mirrors `toolRosterDrift`'s `chatSurfacedKinds` (FE-T22)
   * threading pattern.
   */
  readonly forbiddenOpsKinds: ReadonlySet<string>;
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
  // BKL-096 drift test — see CapabilityDefinition.opsForbiddenDestructive.
  // Extracted to `forbiddenOpsVerbProblems` (ops-verb-scope.ts, FE-T24 review
  // fix) so a freshness test can drive this SAME real check with a generated
  // forbidden set; `input.forbiddenOpsKinds` is REQUIRED (FE-T26 CONTRACT).
  problems.push(...forbiddenOpsVerbProblems(input.opsTools, input.forbiddenOpsKinds));
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
