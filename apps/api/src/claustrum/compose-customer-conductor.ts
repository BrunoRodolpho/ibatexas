// compose-customer-conductor.ts — the CUSTOMER conductor plane's composition,
// extracted out of claustrum-bootstrap.ts (R1-S1).
//
// The composition and the INFRASTRUCTURE RESOLUTION used to be one function. That
// made the customer plane's wiring facts — `readAnswer` is always on; ONE funnel
// instance reaches both the planner and the responder; the claims seams wrap the
// SAME planner the conductor gets — reachable only by booting a real Postgres, a
// real Redis and a real model provider. So the e2e harness hand-copied the
// composition instead, and a hand copy drifts: it is a second composition root
// that nothing forces to agree with the first.
//
// This module is the composition, and nothing else. Every ingredient arrives as a
// dep (`CustomerConductorDeps`); production resolves them in
// claustrum-bootstrap.ts and makes ONE call. It is deliberately import-pure —
// nothing from the bootstrap, no pg/redis/stripe/domain client, no logger, no
// module-scope mutable state, and no `process.env` read outside the one that has
// always lived inside `deriveIbatexasPlannerContext` — so a unit test composes it
// with plain objects, at unit cost, and asserts the wiring facts directly.
//
// This is a seam extraction: the moved code and its comments are verbatim, only
// re-bound to the deps bag. The conductor this composes is byte-identical to the
// one the inline block composed.

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
  type ResponderPort,
  type SessionLock,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
  type ToolRegistry,
} from "@claustrum/core";
import { IBATEXAS_COMPOSED_CAPABILITY_PLANNERS } from "@ibatexas/packs-composed";
// The guest-marker convention, imported from the LEAF that owns it rather than via
// the tool registry's re-export: same function either way (guest-identity.ts is the
// single definition), but the leaf keeps this module's import graph free of the
// registry's pack/Redis dependencies — which is what lets a unit test compose it.
import { isGuestCustomerId } from "../tools/guest-identity.js";
import {
  createIbatexasPlanner,
  type ClaimAwarePlannerPort,
} from "./ibatexas-planner.js";
import { createIbatexasResponder } from "./ibatexas-responder.js";
import { renderCustomerActionAnswer } from "./customer-action-render.js";
import { observeWorkflowDecisions } from "./workflow/workflow-install.js";
import { currentWorkflowTurnId } from "./workflow/workflow-turn.js";
import type { WorkflowRuntime } from "./workflow/workflow-runtime.js";
import type { ClaimsSeams } from "./claims-pipeline.js";
import type { SafeUnknownGate } from "./safe-unknown-gate.js";
import type { CapabilityRetriever } from "./capability-retrieval.js";
import type { createParseFunnel, FunnelParseMemoSeam } from "./funnel-tier.js";
import type { IbatexasPromptComposer } from "./prompts/ibatexas-prompts.js";
import type { ScheduleSignal } from "./closed-hours.js";

/**
 * The customer plane's ONE parse-funnel instance — every tier seam the planner and
 * the responder read (L0/L1/L2/ALIAS), which is exactly what `createParseFunnel`
 * returns. Derived from the factory rather than re-listed so a new tier seam cannot
 * be added to the funnel without this composition being able to carry it.
 */
export type CustomerFunnelSeam = ReturnType<typeof createParseFunnel>;

/**
 * Everything the customer conductor is composed FROM. Production resolves these
 * from live infrastructure (claustrum-bootstrap.ts); a test supplies doubles.
 *
 * The split is deliberate: an ingredient that is a pure import (the planner and
 * responder factories, the composed capability planners, the workflow decision
 * observer, the customer action render) is imported here, and an ingredient that
 * needs infrastructure, config, or a logger is a dep. Nothing in between.
 */
export interface CustomerConductorDeps {
  /**
   * The kernel-facing port, UNWRAPPED. The composer applies
   * `observeWorkflowDecisions` itself — that observer is part of what "the customer
   * conductor" means, not something a caller may forget.
   */
  readonly adjudicator: Adjudicator;
  /** The workflow runtime: planner surface, decision observer, confirm/notice renders. */
  readonly workflowRuntime: WorkflowRuntime;
  /** The chat/synthesis model provider (shared singleton). */
  readonly model: ModelProvider;
  readonly chatModelId: string;
  readonly memory: MemoryPort;
  readonly grounding: GroundingPort;
  readonly channels: ReadonlyArray<ChannelDriver>;
  readonly telemetry: TelemetryPort;
  readonly session: SessionPort;
  readonly tools: ToolRegistry;
  readonly tenantResolver: TenantResolver;
  readonly resolver: ResolverPort;
  readonly sessionLock: SessionLock;
  /** The FINISHED handoff port (production: `natsHandoff(publish, parkDeps)`). */
  readonly handoff: HandoffPort;
  readonly promptComposer: IbatexasPromptComposer;
  readonly explainer: ExplainerPort;
  readonly resolveScheduleSignal: () =>
    | Promise<ScheduleSignal | undefined>
    | ScheduleSignal
    | undefined;
  /**
   * ONE funnel instance. The composer wires it into BOTH the planner and the
   * responder, which is the invariant that keeps the two from disagreeing about a
   * turn's stamped tier — so it lives here, in the composition, and a caller cannot
   * hand out two instances by accident.
   */
  readonly funnel: CustomerFunnelSeam;
  /**
   * LE2-008 — the L2 retriever, present only when the composition declared an
   * embedder. Absent ⟹ full-roster surface (the honest degrade, not a flag).
   */
  readonly capabilityRetriever?: CapabilityRetriever;
  /** BKL-027 — the one-hop read-tool executor registry. */
  readonly readToolExecutors: Readonly<
    Record<string, (input: unknown, state: CognitiveState) => Promise<unknown>>
  >;
  /**
   * B-PR1 — build the claims seams for the planner the conductor is getting. A
   * FACTORY, not a seams object, because the seam must wrap the SAME claim-aware
   * planner instance handed to `createConductor` (Q6b) — and the composer is what
   * knows which instance that is.
   */
  readonly claimsSeamsFor: (planner: ClaimAwarePlannerPort) => ClaimsSeams;
  /**
   * BKL-078 — build the question-shape SAFE-UNKNOWN gate, or `undefined` to omit it.
   * A FACTORY so it is invoked per responder construction, exactly where the inline
   * `claimsPipelineEnabled() ? { safeUnknown: createSafeUnknownGate() } : {}`
   * spread invoked it.
   */
  readonly safeUnknownGateFor: () => SafeUnknownGate | undefined;
  /**
   * THE ONE DECLARED TEST-PLANE DIVERGENCE (R1-S2). Replaces the responder the
   * CONDUCTOR is given; `buildResponder` is still returned and still builds the
   * production responder, so the managed-agent plane's recomposition path is
   * unaffected.
   *
   * PRODUCTION MUST NOT SET IT. It exists so the e2e harness can be the composer's
   * second adapter without also adopting the production reply surface: the harness
   * default is an inert responder whose `decision=X acted=Y` text ~20 suites assert
   * on, and converting all of them to production reply-shaping at once is a
   * different change from deleting a drifted composition twin. A harness test that
   * wants the real responder simply omits this and gets the production one.
   *
   * Deliberately a FINISHED PORT rather than a factory: the divergence is "which
   * responder the conductor got", which is a composition fact the caller already
   * holds, and a factory would invite a second responder-shaping policy to grow
   * here — the drift this whole extraction exists to remove.
   */
  readonly responderOverride?: ResponderPort;
}

/** What the composition hands back. */
export interface ComposedCustomerConductor {
  /** The composed customer-plane Conductor. */
  readonly conductor: Conductor;
  /**
   * The planner/responder factories the MANAGED-AGENT plane recomposes over its
   * per-trigger capped model (H1). Returned rather than re-declared there so
   * "wire BOTH points" stays one change.
   */
  readonly buildPlanner: (model: ModelProvider) => ClaimAwarePlannerPort;
  readonly buildResponder: (model: ModelProvider) => ResponderPort;
}

/**
 * Map the claustrum CognitiveState onto the union (state, context) the pack
 * capability planners read. Each pack reads only its own `ctx` field
 * (orders/reservations: customerId; reservations: staffId; onboarding:
 * isAuthenticated; payments/whatsapp: none), so a union ctx satisfies all.
 *
 * WS3 — thread the real actor. The Capsule carries the authoritative actor, but
 * `PlannerPort.propose` (and therefore `deriveContext`) is handed only a
 * `CognitiveState`, never the Capsule. The faithful in-CognitiveState carrier of
 * the customer identity is `state.memory.customerId`: `handleTurn` assembles
 * `cognition.memory = capsule.memory.recall(capsule.customerId, …)` and
 * `MemorySnapshot.customerId` is exactly the Capsule's customerId. We derive the
 * customer/auth context from it so that AUTHENTICATED intent kinds
 * (`order.checkout.create`, `order.cancel`, `order.amend.request`,
 * `order.note.add`, every `reservation.*`, both `customer.*`) become proposable
 * when a real customer is present — previously hardcoded `customerId:null,
 * isAuthenticated:false` exposed only the unauthenticated subset.
 *
 * Guest convention mirrors `agentCtxFromCapsule` (register-ibatexas-tool-packs):
 * an empty or `guest:`/`anon:`-prefixed customerId is NOT a real customer — it
 * yields `customerId:null, isAuthenticated:false`. The kernel's authGuards remain
 * the authoritative auth check on the envelope; this only widens what the planner
 * is *willing to propose*. `staffId` stays null: a staff actor lives on the
 * Capsule's `actor.role`, which CognitiveState does not carry, so staff-only
 * reservation kinds (`reservation.checkin`/`.complete`) remain non-proposable via
 * the chat planner (they are staff-route only) — a documented follow-up if a
 * staff chat surface is ever wired.
 */
export function plannerCustomerIdFromState(state: CognitiveState): string | null {
  const raw = (state.memory as { customerId?: unknown } | undefined)?.customerId;
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  // A guest/anon-marker or empty id is NOT a real customer → null. Reuses the
  // exported guest-convention predicate from the tool registry (A3) so the
  // planner's willingness-to-propose can never drift from the read-executor
  // identity scope. `isGuestCustomerId` treats empty/whitespace as guest, so
  // the prior explicit `id === ""` guard is subsumed.
  if (isGuestCustomerId(id)) return null;
  return id;
}

export function deriveIbatexasPlannerContext(state: CognitiveState): {
  readonly state: unknown;
  readonly context: unknown;
} {
  const customerId = plannerCustomerIdFromState(state);
  const isAuthenticated = customerId !== null;
  return {
    state: {
      ctx: {
        // Single-tenant supply for the pack tenant-binding authGuard
        // (AuthReviewer-009): the app names the request's tenant in state. The
        // guard REFUSEs a mismatch; env-driven (Hard Rule #3).
        tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
        channel: state.perception.channel,
        // Real actor, derived from the recalled memory snapshot (= Capsule
        // customerId). orders/reservations read `customerId`; onboarding reads
        // `isAuthenticated`.
        customerId,
        staffId: null,
        isAuthenticated,
        cartId: null,
        orderId: null,
      },
    },
    context: {},
  };
}

/**
 * Compose the customer-plane Conductor over resolved infrastructure.
 *
 * Pure: no I/O, no boot side effects, no env read beyond
 * `deriveIbatexasPlannerContext`'s tenant id. Calling it twice with the same deps
 * yields two equivalent conductors.
 */
export function composeCustomerConductor(
  deps: CustomerConductorDeps,
): ComposedCustomerConductor {
  const {
    chatModelId,
    promptComposer,
    telemetry,
    resolveScheduleSignal,
    readToolExecutors,
    funnel,
    capabilityRetriever,
    workflowRuntime,
    explainer: ibxExplainer,
  } = deps;

  const buildPlanner = (model: ModelProvider): ClaimAwarePlannerPort =>
    createIbatexasPlanner({
      model,
      modelId: chatModelId,
      capabilityPlanners: IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
      deriveContext: deriveIbatexasPlannerContext,
      promptComposer,
      telemetry,
      resolveScheduleSignal,
      // BKL-027 — activate the one-hop read-tool enrichment loop.
      readToolExecutors,
      funnel,
      // LE2-009 — the L1 half of the same instance (see IbatexasPlannerDeps.parseMemo
      // for why the two seams are passed separately rather than as one object).
      ...(funnel.lookupParse !== undefined ? { parseMemo: funnel as FunnelParseMemoSeam } : {}),
      // LE2-008 — the L2 seams: the retriever plus the SAME funnel instance that
      // carries L0/L1, so all three tiers stamp into one per-turn stage store and
      // the trace can never name two tiers for one turn.
      ...(capabilityRetriever === undefined
        ? {}
        : { retriever: capabilityRetriever, scopeSeam: funnel }),
      // LE2-025b — alias canonicalization at parse entry. Unconditional: it is
      // deterministic catalog data with no external dependency (no embedder, no
      // engine), so there is nothing to degrade to and no reason to gate it.
      aliasSeam: funnel,
      // LE2-021 — the workflow selection surface. The planner advertises the
      // closed `start_workflow` enum for this turn's authorized roster and
      // instantiates whatever the model selects from it. Empty corpus ⟹ nothing
      // advertised ⟹ byte-identical wire.
      workflowRuntime,
    });
  const buildResponder = (model: ModelProvider): ResponderPort => {
    // Built HERE, per responder construction, so the timing is the one the inline
    // `claimsPipelineEnabled() ? { safeUnknown: createSafeUnknownGate() } : {}`
    // spread had — see the `safeUnknown` spread below for what it wires.
    const safeUnknownGate = deps.safeUnknownGateFor();
    return createIbatexasResponder({
      model,
      modelId: chatModelId,
      explainer: ibxExplainer,
      promptComposer,
      telemetry,
      resolveScheduleSignal,
      // BKL-215 — the CUSTOMER-plane deterministic mutation-success render. On a
      // committed amend EXECUTE the reply states WHAT THE VERB DID from the
      // executed envelope, never the model (which live-composed a FALSE FAILURE
      // "houve um erro ao adicionar o item" on a real success). Returns undefined
      // for every non-amend kind → the grounded model path below is byte-identical
      // for them. The customer analog of the ops readAnswer.renderAction (BKL-149).
      readAnswer: {
        // No deterministic customer READ render here — customer reads flow
        // through the claims pipeline, not this port (the ops-only read capture).
        render: (_turnId: string) => undefined,
        renderAction: (acted: unknown, _turnId: string) =>
          renderCustomerActionAnswer(acted),
      },
      // LE2-021 — the WHOLE-WORKFLOW confirm. The responder cannot reach the
      // workflow runtime (nothing under `claustrum/workflow/` is importable from
      // it, by design), so the composition root hands it this closure. Returns
      // `undefined` on every turn that selected no workflow, and on any instance
      // with an unresolved param — both degrade to `decision.prompt`, which is
      // the behaviour every confirm had before this line existed.
      workflowConfirm: (turnId: string) => workflowRuntime.renderConfirm(turnId),
      // LE2-022 — the FEASIBILITY notice, wired for the same reason and read on
      // the opposite branch. When a pre-check refuses, the planner drops the
      // anchor envelope, so the turn reaches the responder as a REFUSE on an
      // empty plan; without this closure it would fall through to a model
      // completion and the customer would be told, in prose the model authored,
      // why a route they named is not happening — a proposition the model has no
      // grounds for, since the reason lives in a projection it never saw.
      // `undefined` on every turn no pre-check refused.
      workflowNotice: (turnId: string) => workflowRuntime.renderNotice(turnId),
      // BKL-078 — the customer-plane question-shape SAFE-UNKNOWN gate, wired ONLY
      // when ENABLE_CLAIMS_PIPELINE is on (the SAME flag buildClaimsSeams reads).
      // Closes the `prose_preserved` hallucination leak on the conversational
      // fallback: a non-smalltalk info-question that produced no validated claim
      // degrades to the deterministic proposition-free SAFE_UNKNOWN reply instead of
      // a model-authored prose draft. Flag-OFF → omitted → byte-identical.
      //
      // LE2 decision 6 — the OPS conductor now composes this SAME gate (D5, "ops
      // never wires safe-unknown", is DISSOLVED). The construction lives in
      // `safe-unknown-gate.ts`; the customer plane keeps the closed-hours offer
      // (the default), the staff plane opts out of that customer copy.
      ...(safeUnknownGate === undefined ? {} : { safeUnknown: safeUnknownGate }),
      // LE2-007 — the responder half of the funnel seam (the SAME instance the
      // planner got): an L0-stamped turn renders its pt-BR template instead of the
      // conversational completion.
      funnel,
    });
  };

  // B-PR1 — claims-runtime seams (SDD §M / §Q.6), FLAG DEFAULT-OFF. The planner
  // is hoisted so the claim-planner adapter reuses the SAME claim-aware instance
  // (its `proposeClaims`, Q6b). `buildClaimsSeams` returns {} when
  // ENABLE_CLAIMS_PIPELINE is OFF (the default), so the spread below is a no-op
  // and the Conductor is composed BYTE-IDENTICALLY to today (no INVESTIGATE /
  // CLAIMS-VALIDATE stage runs). ON → the shadow claims path is injected
  // (activation is a later PR). No `clock` is passed (not in the published
  // ConductorOptions; the per-turn clock is PENDING R2a).
  const planner = buildPlanner(deps.model);
  // Built HERE, off the hoisted planner and BEFORE the conductor, so the seams'
  // construction (and, with the flag ON, its fail-closed registry assertion) happens
  // at exactly the point the inline block ran it. Assembling them needs a logger and
  // a NATS sink, which is why the adapter supplies the factory; WHICH planner they
  // wrap is a composition fact, which is why the call is here.
  const claimsSeams = deps.claimsSeamsFor(planner);
  const conductor = createConductor({
    // LE2-021 — the workflow decision observer. OBSERVE-ONLY by construction
    // (every method returns the inner result unchanged), and it reads the turn
    // from the AsyncLocalStorage binding the ingresses install around
    // `handleTurn`, so concurrent turns never cross-bind their confirms. See
    // claustrum/workflow/workflow-turn.ts.
    adjudicator: observeWorkflowDecisions(
      deps.adjudicator,
      workflowRuntime,
      currentWorkflowTurnId,
    ),
    memory: deps.memory,
    grounding: deps.grounding,
    planner,
    // R1-S2 — the declared test-plane divergence. Absent in production (the only
    // caller that sets it is the e2e harness), so this is `buildResponder(model)`
    // there, exactly as before. Note the short-circuit is load-bearing: with an
    // override no production responder is constructed at all, so
    // `safeUnknownGateFor` is not invoked either — the harness plane must not pay
    // for, or be observed through, a responder its conductor never uses.
    responder: deps.responderOverride ?? buildResponder(deps.model),
    explainer: ibxExplainer,
    handoff: deps.handoff,
    telemetry,
    session: deps.session,
    tools: deps.tools,
    channels: deps.channels,
    tenantResolver: deps.tenantResolver,
    // F4 / conductor rich-state: the pre-adjudication resolve stage assembles the
    // per-pack SystemState (real entity state + sessionTokensConsumed) so the
    // kernel adjudicates commerce mutations correctly instead of panic-REFUSING
    // against the stub tenant state. See claustrum/resolve-and-assemble.ts.
    resolver: deps.resolver,
    // RC-R3 / Decision 1: without a distributed lock the conductor falls back to
    // its in-process InMemorySessionLock, so two api replicas would adjudicate
    // the same `${channel}:${customerId}` session concurrently (double-EXECUTE).
    // Postgres advisory locks pin acquire/release to one pooled connection.
    sessionLock: deps.sessionLock,
    // B-PR1 — OFF by default → {} (no-op spread, byte-identical). ON → the three
    // optional claims seams (investigator / claimPlanner / claimsKernel).
    ...claimsSeams,
  });

  return { conductor, buildPlanner, buildResponder };
}
