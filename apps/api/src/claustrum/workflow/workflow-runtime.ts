// The WORKFLOW RUNTIME v0 (LE2-020) — instantiation, the catalog-version pin,
// and per-activity kernel adjudication.
//
// ── THE SHAPE OF A RUN ───────────────────────────────────────────────────────
//
//   1. SELECT   — the parser calls `start_workflow` from a CLOSED surface. The
//                 runtime validates the id against that same surface, resolves
//                 every declared param from a validated claim or a
//                 customer-authored slot, and mints an INSTANCE that PINS
//                 `CATALOG_VERSION`. Nothing has been adjudicated yet.
//   2. CONFIRM  — the selection envelope (the workflow's governance ANCHOR) is
//                 adjudicated by the kernel like any other capability. Its
//                 CONFIRM is the whole-workflow confirm, and the prompt the
//                 customer reads QUOTES the kernel's own grounded sentence.
//   3. RUN      — only after the customer confirms and the kernel returns
//                 EXECUTE on the anchor. Each activity is adjudicated
//                 INDIVIDUALLY, in order, writing its own audit row.
//   4. RENDER   — from the authored template for the outcome reached.
//
// ── WHAT THE RUNTIME IS NOT ALLOWED TO DO ────────────────────────────────────
//
// It never adjudicates anything itself, never bypasses a guard, and never
// decides that a step is safe. It CHOOSES WHICH ENVELOPE TO SUBMIT; the kernel
// decides whether it runs. That is why `adjudicateActivity` is injected rather
// than built here: the runtime cannot reach a policy bundle, so there is no
// code path in which it could adjudicate against a policy of its own choosing.
//
// Money is the sharpest case and it is handled by doing nothing special: an
// activity that crosses a money band meets the same band it would meet outside
// a workflow, because it is the same kernel over the same guards.
//
// ── THE CONFIRM RULE, AS REFINED BY LE2-023 ──────────────────────────────────
//
// LE2-022 stated it as "a workflow confirm does not pre-authorize a step's own
// confirm". The rule it was protecting is the SEMANTIC one — *the customer must
// actually be asked the question the guard would ask* — and blanket
// non-coverage was the cheapest way to guarantee it while nothing could express
// "and this time they were".
//
// The rule now reads: A STEP'S OWN CONFIRM IS RESOLVED ONLY WHERE THE CATALOG
// DECLARES THAT THE WHOLE-WORKFLOW CONFIRM ASKED THAT EXACT QUESTION, AND ONLY
// WITH THE CUSTOMER'S OWN WITNESSED AFFIRMATION. Everything undeclared behaves
// exactly as it did before — the step does not execute, the run stops, the
// compensators fire — and the fixture corpus still pins that (the conditional
// fixture's `finishCheckout` meets `confirmLargeTicket` and compensates).
//
// An ESCALATE is never coverable, so the money ladder's upper band is untouched
// by construction: `resolveCoveredConfirm` acts on REQUEST_CONFIRMATION alone.
//
// ── THE PIN, AND WHY IT IS NOT A LICENCE ─────────────────────────────────────
//
// LE2 Implementation Decision 17: "journey instances pin shape, adjudicate
// fresh". The instance pins the catalog version it started under, so the SHAPE
// of the run — which activities, in which order, with which templates — is
// stable even if the catalog changes mid-run. It does NOT pin policy: every
// activity passes current-code adjudication, so a policy change bites
// immediately, and a run whose pinned shape is no longer permitted fails closed
// with an honest render rather than executing a stale plan.
//
// ── FAIL-CLOSED, SEQUENTIALLY ────────────────────────────────────────────────
//
// v0 is linear with no compensation (ticket 22 owns that). So a step that does
// not reach EXECUTE STOPS the run: later activities are never submitted. The
// alternative — carrying on past a refusal — would leave the customer with a
// partial result they never agreed to, and with no compensator to undo it. The
// trace records exactly how far it got.

import { randomUUID } from "node:crypto";
import { buildEnvelope, type Decision, type IntentActor, type IntentEnvelope } from "@adjudicate/core";
import {
  CATALOG_VERSION,
  findWorkflow,
  findWorkflowActivity,
  workflowActivityKinds,
  workflowOutcomeText,
  workflowRoute,
  workflowSelectionKinds,
  workflowSlotNames,
  workflowTemplateText,
  workflowTriggerPhrasings,
  type WorkflowActivity,
  type WorkflowDefinition,
} from "@ibatexas/catalog";
import { logger } from "../../lib/logger.js";
import { sortedByCodeUnits } from "./workflow-ordering.js";
import {
  buildActivityPayload,
  renderWorkflowTemplate,
  resolveWorkflowParams,
  type ResolvedParam,
  type ValidatedClaimValues,
  type WorkflowParamValue,
  type WorkflowSlots,
} from "./workflow-params.js";
import {
  describeWorkflowPredicate,
  evaluateWorkflowPredicate,
  type WorkflowFacts,
} from "./workflow-predicates.js";
import {
  recordWorkflowTrace,
  type WorkflowBranchRecord,
  type WorkflowRunOutcome,
  type WorkflowStepRecord,
  type WorkflowTrace,
} from "./workflow-trace.js";

/**
 * One instantiated workflow, alive for the turn that selected it and the turn
 * that confirms it.
 */
export interface WorkflowInstance {
  readonly instanceId: string;
  readonly workflowId: string;
  /** THE PIN — the catalog serial this instance was instantiated under. */
  readonly catalogVersion: number;
  /** The definition as it was at instantiation, so the run's SHAPE is stable. */
  readonly definition: WorkflowDefinition;
  readonly params: ReadonlyMap<string, ResolvedParam>;
  /** Params that did not resolve; a non-empty list fails the run. */
  readonly unresolved: readonly string[];
  /**
   * LE2-023 — the CUSTOMER-AUTHORED SLOTS this instance was selected with,
   * already stripped to the workflow's declared names by the parse seam's
   * `sanitizeWorkflowSlots`.
   *
   * Carried on the instance because a FACT PROJECTION may need one. LE2-022's
   * facts were all questions about the customer's stored world — their cart,
   * their last order — which a projection can answer from an actor alone.
   * LE2-023 adds facts that are questions about the customer's world AND
   * SOMETHING THEY SAID: `couponIsValid` is not a property of the customer, it
   * is a property of the customer's order and THIS coupon code. Without the
   * slots reaching `projectFacts`, every coupon fact would be permanently
   * ABSENT, every pre-check over one would refuse, and the workflow could never
   * be offered — the silent always-false failure `predicate-fact-unknown`
   * exists to prevent one layer up.
   *
   * It grants NO new authority. These are the same values `resolveWorkflowParams`
   * already consumed, from the same closed slot surface, and the projection they
   * feed does what every other projection here does: a first-party read. A slot
   * is model-EXTRACTED but customer-AUTHORED (see `WorkflowParamSource`), and
   * handing one to a store lookup is exactly what the `"slot"` member is for.
   */
  readonly slots: WorkflowSlots;
  readonly startedAt: string;
}

/**
 * A FEASIBILITY VERDICT — LE2-022, the answer `checkFeasibility` gives the
 * planner.
 *
 * `undefined` means feasible (or that the workflow declares no pre-check), and
 * the anchor envelope is minted as usual. A value means the workflow will not
 * run: the planner drops the envelope, so nothing is adjudicated, nothing parks,
 * and the customer is never shown a confirm for something already impossible.
 */
export interface WorkflowInfeasibility {
  readonly instanceId: string;
  readonly workflowId: string;
  /** The pre-check that did not hold — the trace's join key. */
  readonly precheckId: string;
  /** The AUTHORED pt-BR reason. Already rendered; the responder shows it verbatim. */
  readonly reason: string;
}

/** One entry of the CLOSED surface the parser selects from. */
export interface AdvertisedWorkflow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** The customer-authored slot names this workflow accepts. Closed. */
  readonly slots: readonly string[];
  /**
   * LE2-021 — the authored ways customers ASK for this workflow, natural pt-BR,
   * in authored (strongest-evidence-first) order.
   *
   * On the wire, not documentation: `startWorkflowToolDefinition` composes them
   * into the tool description. LE2-020 shipped a description-only surface and
   * LE2-021's live drive measured what that costs — 87.5% selection, with one
   * ordinary idiom selecting 0/5 — which is the same gap LE2-008 measured for
   * capabilities (recall@5 = 73.8% on descriptions alone) in the same shape.
   */
  readonly triggerPhrasings: readonly string[];
}

export interface WorkflowRuntimeDeps {
  /** The authored corpus this composition loads. Empty ⟹ the runtime is inert. */
  readonly workflows: readonly WorkflowDefinition[];
  /**
   * Adjudicate ONE activity envelope. Injected, never built here — the runtime
   * has no access to a policy bundle, which is what makes "the runtime cannot
   * adjudicate against a policy of its own choosing" structural.
   */
  readonly adjudicateActivity: (
    envelope: IntentEnvelope,
    /**
     * LE2-023 — the CONFIRMATION RECEIPT for a declared-covered activity, and
     * the ONLY way this runtime can resolve an activity's own
     * REQUEST_CONFIRMATION. Absent on every ordinary submission, which is every
     * submission a workflow without `confirmCoveredBy` ever makes.
     *
     * The composition root forwards it to `adjudicateAndAudit`'s own
     * `confirmationReceipt` slot, so the kernel's rules apply unchanged: the
     * hash must match, EVERY state/taint/auth/business guard still runs, and
     * only the threshold-style "ask the user first" step is satisfied. A REFUSE
     * or an ESCALATE comes back untouched — the receipt cannot rescue either.
     */
    opts?: { readonly confirmationReceipt: WorkflowActivityReceipt },
  ) => Promise<Decision>;
  /**
   * LE2-023 — where an ESCALATED activity goes so a HUMAN can see it.
   *
   * The conductor routes an ESCALATE through `capsule.handoff.queue`, which is
   * what parks the envelope and publishes `support.handoff_requested` — the
   * Escalações row, the pending-escalations KPI and the staff ping. The workflow
   * runtime never reaches that stage: it adjudicates and dispatches directly, so
   * before this port an escalated activity wrote ONE audit row and was visible
   * nowhere else. That is exactly the hole BKL-103 closed for the direct plane,
   * and it was latent here for EVERY activity and compensator, not only the
   * cancel this ticket adds.
   *
   * INJECTED for the same structural reason `adjudicateActivity` is: the runtime
   * must not be able to reach a broker or a park store on its own, so the only
   * escalation surface it has is the one its composition handed it. Production
   * passes the SAME `natsHandoff(publishNatsEvent, escalationHandoffParkDeps)`
   * the customer conductor uses, so the workflow plane inherits the
   * conversational park contract — including the sessionId the approve path
   * already matches on — rather than a second, drifting copy of it.
   *
   * ABSENT ⟹ nothing is surfaced, which is what a composition that has not
   * wired it gets. The step still records `ESCALATE` and the run still reaches
   * the honest `escalated` outcome; what is lost is the staff surface, and it is
   * lost loudly (see the warn in `submitActivity`).
   */
  readonly escalationHandoff?: {
    queue: (envelope: IntentEnvelope, reason: string) => Promise<void>;
  };
  /** Dispatch an EXECUTE-d activity through the real tool registry. */
  readonly dispatchActivity: (envelope: IntentEnvelope, ctx: unknown) => Promise<unknown>;
  /**
   * LE2-023 — HOST-RESOLVED PAYLOAD FIELDS, stamped before the envelope is minted.
   *
   * ── WHY THIS SEAM HAS TO EXIST, AND HAS TO BE HERE ──────────────────────────
   *
   * Two fields a workflow activity needs cannot come from `WorkflowParamSource`,
   * and both are needed by `order.cancel`:
   *
   *   `orderId` — an IDENTIFIER. The two admissible param sources are a validated
   *     claim and a customer slot, and an order id is exactly what neither may
   *     carry: no registry claim exposes one, and a slot would be model-extracted,
   *     which for an identifier is the confabulation that union exists to prevent.
   *     It is resolved host-side from the same OWNER-SCOPED previous-order read
   *     that grounded the confirm sentence, so the order the saga cancels is the
   *     order the customer was shown.
   *   `actorId` — the BKL-103 PROPOSER STAMP. `ESCALATION_PROPOSER_STAMPS` reads
   *     `payload.actorId` to park a resumable escalation, and `gatePaidCancel`'s
   *     owner-approval overlay refuses to convert without a non-empty proposer.
   *     Unstamped, an escalated in-saga cancel would be unapprovable — the
   *     customer told a human would review it, and no human able to.
   *
   * It runs BEFORE `buildEnvelope` because `intentHash` covers the payload.
   * Stamping after would produce a hash that does not describe what the kernel
   * adjudicates, and every downstream identity — the park's hash match, the
   * confirmation receipt, the audit row — is keyed on it.
   *
   * INJECTED for the reason every other port here is: the runtime must not be
   * able to reach a store on its own, so the only fields it can add are the ones
   * its composition resolves for it. ABSENT ⟹ the payload is used verbatim,
   * which is LE2-022's behaviour exactly and is what every workflow without a
   * host-resolved field gets.
   */
  readonly resolveActivityPayload?: (args: {
    readonly capability: string;
    readonly payload: Readonly<Record<string, WorkflowParamValue>>;
    readonly actor: IntentActor;
  }) => Promise<Readonly<Record<string, WorkflowParamValue>>>;
  /** This turn's VALIDATED claims, for claim-sourced params. */
  readonly claimsFor?: (turnId: string) => ValidatedClaimValues | undefined;
  /**
   * LE2-022 — THE GROUNDED FACTS a declared predicate reads, projected by the
   * composition root out of the SAME resolver-assembled `SystemState.ctx` the
   * kernel's guards are adjudicated against (see `workflow-facts.ts`).
   *
   * Injected for exactly the reason `adjudicateActivity` is: the runtime cannot
   * reach a resolver, so there is no code path in which it could derive a
   * condition from a second, separately-computed view of the customer's state —
   * or from a model. ABSENT ⟹ NO fact resolves ⟹ every pre-check refuses and
   * every branch takes its `otherwise` arm, which is the fail-closed direction
   * and is what a composition that has not wired this gets.
   */
  readonly projectFacts?: (args: {
    readonly turnId: string;
    readonly actor: IntentActor;
    /**
     * LE2-023 — the selecting turn's customer-authored slots. See
     * {@link WorkflowInstance.slots} for why a projection needs them and why
     * passing them widens nothing.
     */
    readonly slots: WorkflowSlots;
  }) => Promise<WorkflowFacts>;
  /**
   * LE2-022 — the catalog serial IN FORCE NOW, as against the one an instance
   * pinned at selection. Defaults to the module constant.
   *
   * A seam rather than a direct read so a run can RECORD the drift when a
   * workflow parked across a deploy resumes on a shape the catalog has since
   * moved past. Nothing branches on it — the instance runs its pinned definition
   * either way — it is written to the trace so an operator can see from the
   * outside which definition a run actually executed.
   */
  readonly currentCatalogVersion?: () => number;
  readonly now?: () => number;
  readonly newInstanceId?: () => string;
}

export interface WorkflowRuntime {
  /**
   * The closed surface for a turn, given the capability roster the planners
   * authorized. A workflow is offered only when EVERY matcher holds — so the
   * surface can only ever narrow what was already authorized.
   */
  advertise(allowedIntents: ReadonlyArray<string>): readonly AdvertisedWorkflow[];
  /**
   * Instantiate a workflow the parser selected. Returns `undefined` when the id
   * is not on the closed surface for this turn — the defense-in-depth twin of
   * the planner's `allowed.has(capability)` check.
   */
  select(args: {
    readonly turnId: string;
    readonly workflowId: string;
    readonly slots: WorkflowSlots;
    readonly allowedIntents: ReadonlyArray<string>;
  }): WorkflowInstance | undefined;
  /** This turn's instance, if the parser selected one (the SELECTING turn). */
  instanceFor(turnId: string): WorkflowInstance | undefined;
  /**
   * An instance by its id — the lookup the CONFIRMING turn uses.
   *
   * A confirm flow spans two turns with two different turn ids, so the turn id
   * cannot be the handle that survives the park. The instance id can: it rides
   * the anchor envelope's payload into the parked envelope and comes back
   * verbatim when the customer's "sim" resumes it. That is also why it is a
   * pure lookup key and never an authority — resuming with a forged id gets you
   * an instance whose activities are still adjudicated one by one.
   */
  instanceById(instanceId: string): WorkflowInstance | undefined;
  /**
   * LE2-022 — evaluate this turn's instance against its declared FEASIBILITY
   * PRE-CHECKS, before the planner mints the anchor envelope.
   *
   * ── WHY IT IS A SEPARATE CALL AND NOT PART OF `select` ───────────────────────
   *
   * Because it needs a grounded projection, and a projection needs IO, and
   * `select` is called from the planner's synchronous tool-call translation.
   * Splitting it keeps that seam synchronous and puts the read exactly where the
   * planner can `await` it — which is still strictly BEFORE the envelope exists,
   * which is the property the AC is about. A pre-check that ran after the
   * envelope would be racing the kernel's own CONFIRM for the right to speak
   * first, and the kernel would win.
   *
   * Returns `undefined` when the workflow is feasible, when it declares no
   * pre-check, or when this turn selected nothing.
   */
  checkFeasibility(args: {
    readonly turnId: string;
    readonly actor: IntentActor;
  }): Promise<WorkflowInfeasibility | undefined>;
  /**
   * The AUTHORED reason a pre-check refused this turn's workflow, or `undefined`
   * when none did — the responder's read side of {@link checkFeasibility}.
   */
  renderNotice(turnId: string): string | undefined;
  /** Record the kernel's verdict on the ANCHOR, so the confirm can quote it. */
  recordSelectionDecision(turnId: string, decision: Decision): void;
  /** The whole-workflow confirm prompt, or `undefined` when there is none. */
  renderConfirm(turnId: string): string | undefined;
  /** Render an outcome's authored template. */
  renderOutcome(instance: WorkflowInstance, outcome: WorkflowRunOutcome): string;
  /** Run the activity sequence. Only ever called after the anchor EXECUTEs. */
  run(args: {
    readonly instanceId: string;
    readonly turnId: string;
    readonly actor: IntentActor;
    readonly ctx: unknown;
  }): Promise<WorkflowTrace | undefined>;
  /** The capability kinds that ANCHOR a loaded workflow. */
  selectionCapabilities(): ReadonlySet<string>;
  /** Every capability kind a loaded workflow's ACTIVITIES invoke. */
  activityCapabilities(): ReadonlySet<string>;
  /** INGRESS SEAM — drop this turn's instance. */
  close(turnId: string): void;
}

/** LRU cap, mirroring `funnel-tier.ts`'s per-turn maps. */
const MAX_TRACKED_TURNS = 500;

function evictOldest(map: Map<string, unknown>): void {
  if (map.size < MAX_TRACKED_TURNS) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/** Read a decision's first basis code structurally (shapes vary by pack). */
function basisCodeOf(decision: Decision): string | undefined {
  const basis = (decision as { basis?: unknown }).basis;
  if (!Array.isArray(basis)) return undefined;
  const code = (basis[0] as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Every basis entry a decision carries, structurally. */
function basisEntriesOf(decision: Decision): readonly Record<string, unknown>[] {
  const basis = (decision as { basis?: unknown }).basis;
  return Array.isArray(basis) ? (basis as Record<string, unknown>[]) : [];
}

/**
 * The `reason` a decision's business basis states — the value a
 * {@link WorkflowConfirmCoverage} matches against.
 *
 * A REASON, not a guard name, because the reason is what actually rides into
 * the audit row and because one guard can ask two different questions under two
 * reasons. Covering "the guard" would silently cover both; covering the reason
 * covers the question that was actually asked.
 */
function basisReasonsOf(decision: Decision): readonly string[] {
  const reasons: string[] = [];
  for (const entry of basisEntriesOf(decision)) {
    const detail = entry["detail"];
    if (detail === null || typeof detail !== "object") continue;
    const reason = (detail as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason !== "") reasons.push(reason);
  }
  return reasons;
}

/**
 * Did THIS decision reach EXECUTE because the customer affirmatively confirmed?
 *
 * The kernel appends a `confirmation:received` basis whenever a matching
 * `confirmationReceipt` turned a REQUEST_CONFIRMATION into an EXECUTE. That
 * basis is the ONLY evidence this runtime accepts that a customer said yes, and
 * reading it rather than inferring it is the point: "we got here, so they must
 * have agreed" is an argument about control flow, and control flow is exactly
 * what a future edit changes without noticing.
 */
function carriesConfirmationReceipt(decision: Decision | undefined): boolean {
  if (decision === undefined) return false;
  if (String((decision as { kind?: unknown }).kind ?? "") !== "EXECUTE") return false;
  return basisEntriesOf(decision).some(
    (entry) => entry["kind"] === "confirmation" && entry["code"] === "received",
  );
}

/**
 * THE RECEIPT a covered activity is re-adjudicated with — LE2-023.
 *
 * Minted by the runtime, for ONE envelope, from an affirmation the kernel itself
 * witnessed. Every field is deliberately narrow:
 *
 *   `intentHash` — THIS activity envelope's own hash. The kernel refuses to
 *     substitute anything whose hash does not match, so a receipt cannot be
 *     carried from one step to another, replayed onto a different payload, or
 *     reused after a resolved param changed the envelope.
 *   `at` — when the customer's affirmation was observed on this turn.
 *
 * There is no token, and deliberately no `binding`: this receipt is not the
 * product of a confirmation STORE exchange, and dressing it as one would put a
 * forensic marker in the audit row asserting a token flow that did not happen.
 * What the row does carry is the truth — a `confirmation:received` basis on an
 * envelope whose coverage the catalog declared, which is exactly as much as was
 * actually established.
 */
export interface WorkflowActivityReceipt {
  readonly intentHash: string;
  readonly at: string;
}

/** The customer-facing sentence a CONFIRM decision carries, if any. */
function confirmPromptOf(decision: Decision): string | undefined {
  const record = decision as {
    prompt?: unknown;
    userFacing?: unknown;
    confirmation?: { prompt?: unknown };
  };
  for (const candidate of [
    record.prompt,
    record.confirmation?.prompt,
    record.userFacing,
  ]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return undefined;
}

/**
 * Submit ONE activity: mint its envelope, put it through the kernel, and — only
 * on EXECUTE — dispatch it. Always returns a step record, whatever the kernel
 * said: a refused step is not an error to swallow, it is the single most useful
 * row the trace can carry (see workflow-trace.ts).
 *
 * Extracted from the sequence loop because "submit one activity and report what
 * the kernel said" is the unit the whole design turns on — per-activity
 * adjudication — and it is worth being able to read it without the loop's
 * bookkeeping around it.
 */
/**
 * Resolve a DECLARED-COVERED activity confirm — LE2-023, the whole of ruling (a).
 *
 * Returns the original decision untouched in every case but one. The single case
 * it acts on requires ALL FOUR of these to hold at once:
 *
 *   1. the kernel said REQUEST_CONFIRMATION — never ESCALATE, never REFUSE. An
 *      escalation means a human must look, and no amount of customer agreement
 *      substitutes for that, so the money ladder's upper band is untouched here
 *      by construction rather than by care;
 *   2. the ACTIVITY declares `confirmCoveredBy` — absent is the default and the
 *      default is LE2-022's behaviour, byte-for-byte: the step does not execute,
 *      the run stops, the compensators fire;
 *   3. the decision's own basis states the EXACT reason the coverage names, so a
 *      guard that starts asking a second, different question under a second
 *      reason is not covered and stops the run;
 *   4. the customer AFFIRMED this run's anchor on this turn, witnessed by the
 *      kernel's own `confirmation:received` basis — not inferred from the fact
 *      that we are executing.
 *
 * Then, and only then, the IDENTICAL envelope is re-adjudicated with a receipt
 * for its own hash. Every guard runs again; only the ask-first threshold is
 * satisfied. If that second pass returns anything other than EXECUTE, that is
 * the answer — the coverage is not a second chance, it is an answer to one
 * specific question that had already been asked.
 */
async function resolveCoveredConfirm(args: {
  readonly deps: WorkflowRuntimeDeps;
  readonly decision: Decision;
  readonly envelope: IntentEnvelope;
  readonly activity: WorkflowActivity;
  readonly affirmed: boolean;
  readonly turnId: string;
  readonly instanceId: string;
  readonly now: () => number;
}): Promise<Decision> {
  const { deps, decision, envelope, activity, turnId, instanceId, now } = args;
  if (String((decision as { kind?: unknown }).kind ?? "") !== "REQUEST_CONFIRMATION") {
    return decision;
  }
  const coverage = activity.confirmCoveredBy;
  if (coverage === undefined) return decision;

  const reasons = basisReasonsOf(decision);
  if (!reasons.includes(coverage.basisReason)) {
    logger.info(
      {
        component: "workflow",
        event: "workflow.coverage.reason_mismatch",
        turnId,
        instanceId,
        activityId: activity.id,
        declaredReason: coverage.basisReason,
        decisionReasons: reasons,
      },
      "workflow: an activity confirm was NOT the covered question — stopping the run as an uncovered confirm",
    );
    return decision;
  }

  if (!args.affirmed) {
    // No witnessed affirmation ⟹ no receipt ⟹ the confirm stands. Reached when a
    // composition drives the anchor to EXECUTE without a confirm cycle, which is
    // exactly the shape a coverage must never trust.
    logger.warn(
      {
        component: "workflow",
        event: "workflow.coverage.unaffirmed",
        turnId,
        instanceId,
        activityId: activity.id,
        declaredReason: coverage.basisReason,
      },
      "workflow: a covered activity confirm had NO witnessed customer affirmation on this turn — refusing to resolve it",
    );
    return decision;
  }

  const intentHash = (envelope as { intentHash?: unknown }).intentHash;
  if (typeof intentHash !== "string" || intentHash === "") {
    logger.warn(
      {
        component: "workflow",
        event: "workflow.coverage.no_hash",
        turnId,
        instanceId,
        activityId: activity.id,
      },
      "workflow: a covered activity envelope carries no intentHash — refusing to mint a receipt",
    );
    return decision;
  }

  const second = await deps.adjudicateActivity(envelope, {
    confirmationReceipt: { intentHash, at: new Date(now()).toISOString() },
  });
  logger.info(
    {
      component: "workflow",
      event: "workflow.coverage.resolved",
      turnId,
      instanceId,
      activityId: activity.id,
      capability: activity.capability,
      coveredReason: coverage.basisReason,
      outcome: String((second as { kind?: unknown }).kind ?? "UNKNOWN"),
    },
    "workflow: resolved a DECLARED-COVERED activity confirm with the customer's own affirmation",
  );
  return second;
}

/**
 * Hand an ESCALATED activity to the staff surface — LE2-023.
 *
 * Best-effort and LOUD when it fails, mirroring `natsHandoff`'s own posture: the
 * customer's reply must not die on a broker hiccup, and the kernel audit row is
 * the fallback truth. What must never happen silently is the port being absent —
 * that is a composition that promises a human review nobody will see, so it logs
 * at warn even though it changes no behaviour.
 */
async function surfaceEscalation(args: {
  readonly deps: WorkflowRuntimeDeps;
  readonly envelope: IntentEnvelope;
  readonly decision: Decision;
  readonly activityId: string;
  readonly turnId: string;
  readonly instanceId: string;
}): Promise<void> {
  const { deps, envelope, decision, activityId, turnId, instanceId } = args;
  const reason =
    typeof (decision as { reason?: unknown }).reason === "string" &&
    (decision as { reason: string }).reason !== ""
      ? (decision as { reason: string }).reason
      : `workflow activity ${activityId} requires human review`;

  if (deps.escalationHandoff === undefined) {
    logger.warn(
      {
        component: "workflow",
        event: "workflow.escalation.unsurfaced",
        turnId,
        instanceId,
        activityId,
        capability: String(envelope.kind),
      },
      "workflow: an activity ESCALATED but this composition wired no handoff port — the escalation is audit-row-only and no staff surface will show it",
    );
    return;
  }
  try {
    await deps.escalationHandoff.queue(envelope, reason);
    logger.info(
      {
        component: "workflow",
        event: "workflow.escalation.surfaced",
        turnId,
        instanceId,
        activityId,
        capability: String(envelope.kind),
      },
      "workflow: an escalated activity was queued to the staff handoff surface",
    );
  } catch (error) {
    logger.error(
      {
        component: "workflow",
        event: "workflow.escalation.surface_failed",
        turnId,
        instanceId,
        activityId,
        error: error instanceof Error ? error.message : String(error),
      },
      "workflow: queueing an escalated activity to the staff surface FAILED — the kernel audit row is the only record",
    );
  }
}

async function submitActivity(args: {
  readonly deps: WorkflowRuntimeDeps;
  readonly instance: WorkflowInstance;
  readonly activity: WorkflowActivity;
  readonly stepIndex: number;
  readonly payload: Readonly<Record<string, WorkflowParamValue>>;
  readonly actor: IntentActor;
  readonly ctx: unknown;
  readonly turnId: string;
  readonly now: () => number;
  /** LE2-022 — forward step or rollback. A compensator is submitted through
   *  THIS function, not a shortcut beside it: same envelope, same kernel, same
   *  guards, same audit row. A rollback is a governed mutation, and refunding,
   *  cancelling and deleting are exactly the acts a policy most wants to see. */
  readonly role: WorkflowStepRecord["role"];
  /** On a rollback, the forward activity id being undone. */
  readonly compensates?: string;
  /**
   * LE2-023 — did the customer AFFIRM this run's anchor on this turn, witnessed
   * by the kernel's own `confirmation:received` basis? The precondition for
   * resolving any declared coverage; false makes every coverage inert.
   */
  readonly affirmed: boolean;
}): Promise<WorkflowStepRecord> {
  const { deps, instance, activity, stepIndex, payload, actor, ctx, turnId, now } = args;
  const stepStartedAt = now();

  // LE2-023 — host-resolved fields FIRST, so `intentHash` covers them. See
  // `resolveActivityPayload`.
  const resolved =
    deps.resolveActivityPayload === undefined
      ? payload
      : await deps.resolveActivityPayload({
          capability: activity.capability,
          payload,
          actor,
        });

  const envelope = buildEnvelope({
    kind: activity.capability,
    payload: resolved,
    // The SAME actor the selection ran under: a workflow acts for the customer
    // who confirmed it, never for a broader principal.
    actor,
    // Deliberately NOT widened. The values are first-party (validated claims,
    // customer slots, authored constants), but taint describes PROVENANCE of
    // the request, and the request originated in a parse. Widening it here
    // would hand every workflow activity an authority the same mutation would
    // not have outside a workflow.
    taint: "UNTRUSTED",
    nonce: `${instance.instanceId}#${stepIndex}`,
  }) as IntentEnvelope;

  // EACH ACTIVITY, INDIVIDUALLY. Its own envelope, its own adjudication, its
  // own audit row.
  const first = await deps.adjudicateActivity(envelope);
  const decision = await resolveCoveredConfirm({
    deps,
    decision: first,
    envelope,
    activity,
    affirmed: args.affirmed,
    turnId,
    instanceId: instance.instanceId,
    now,
  });
  const decisionKind = String((decision as { kind?: unknown }).kind ?? "UNKNOWN");

  // LE2-023 — AN ESCALATE MUST REACH A HUMAN, or the customer is promised a
  // review that no staff surface will ever show. See `escalationHandoff`.
  if (decisionKind === "ESCALATE") {
    await surfaceEscalation({
      deps,
      envelope,
      decision,
      activityId: activity.id,
      turnId,
      instanceId: instance.instanceId,
    });
  }

  let ran = false;
  if (decisionKind === "EXECUTE") {
    try {
      await deps.dispatchActivity(envelope, ctx);
      ran = true;
    } catch (error) {
      logger.warn(
        {
          component: "workflow",
          event: "workflow.activity.threw",
          turnId,
          instanceId: instance.instanceId,
          activityId: activity.id,
          capability: activity.capability,
          error: error instanceof Error ? error.message : String(error),
        },
        "workflow: an adjudicated activity's executor threw",
      );
    }
  }

  const basisCode = basisCodeOf(decision);
  return {
    instanceId: instance.instanceId,
    stepIndex,
    activityId: activity.id,
    capability: activity.capability,
    decision: decisionKind,
    ...(basisCode === undefined ? {} : { basisCode }),
    executed: ran,
    role: args.role,
    ...(args.compensates === undefined ? {} : { compensates: args.compensates }),
    durationMs: now() - stepStartedAt,
    at: new Date(now()).toISOString(),
  };
}

/**
 * The sequence outcome for a run that never started: a param did not resolve,
 * so NOTHING is submitted. Its own named function because "we refused before
 * the kernel saw anything" is a materially different event from "the kernel
 * refused a step", and the trace has to be able to tell them apart — this one
 * produces ZERO step records.
 */
function unresolvedParamsOutcome(
  instance: WorkflowInstance,
  plan: readonly PlannedStep[],
  turnId: string,
): SequenceOutcome {
  logger.warn(
    {
      component: "workflow",
      event: "workflow.params.unresolved",
      turnId,
      instanceId: instance.instanceId,
      workflowId: instance.workflowId,
      unresolvedParams: instance.unresolved,
    },
    "workflow: params did not resolve from a validated claim or a customer slot — nothing submitted",
  );
  return {
    steps: [],
    branches: [],
    outcome: "failed",
    ...(plan[0] === undefined ? {} : { failedActivityId: plan[0].activity.id }),
    executed: 0,
    compensationsExecuted: 0,
    planned: plan.length,
  };
}

/** What the route did — the input to the run record. */
interface SequenceOutcome {
  readonly steps: readonly WorkflowStepRecord[];
  readonly branches: readonly WorkflowBranchRecord[];
  readonly outcome: WorkflowRunOutcome;
  readonly failedActivityId?: string;
  /** FORWARD activities that reached EXECUTE. Compensations are counted apart. */
  readonly executed: number;
  readonly compensationsExecuted: number;
  /** How many forward activities the resolved plan held. */
  readonly planned: number;
  /** LE2-023 — some step was sent to a HUMAN. See the `escalated` outcome. */
  readonly escalated?: boolean;
}

/** One forward activity the resolved route plan will submit. */
interface PlannedStep {
  readonly activity: WorkflowActivity;
}

/**
 * RESOLVE THE WHOLE ROUTE TO A FLAT PLAN, up front, from ONE fact projection.
 *
 * ── WHY UP FRONT, AND WHY ONE PROJECTION ─────────────────────────────────────
 *
 * Every branch is evaluated against the SAME grounded snapshot, taken before any
 * activity has run. Re-projecting at each branch would look "fresher" and is
 * wrong in the way that matters here: the customer approved a run described by
 * the state at confirm time, and a mid-run re-projection lets the workflow's OWN
 * earlier mutations flip a branch nobody was ever shown. A run is one decision;
 * it should be planned against one view of the world.
 *
 * It also makes the plan KNOWABLE before anything is submitted, which is what
 * lets `activitiesTotal` mean "how many steps this run set out to take" instead
 * of something that only becomes true in hindsight. A path length that grows as
 * a run proceeds cannot be compared across runs, and comparing runs is the whole
 * of the operator view.
 *
 * The pin still holds and the facts are still fresh at the RIGHT moment: the
 * projection happens on the CONFIRMING turn, so a workflow parked overnight
 * plans against the world as it is when it resumes — not as it was when the
 * customer asked.
 *
 * An arm naming an activity the workflow does not declare is a BUILD error
 * (`route-target-dangling`), so the skip below is unreachable on any compiled
 * corpus. It is a skip rather than a throw because a definition the compiler
 * never saw must not take a conversational turn down with it — and it is logged,
 * because a silently shorter plan is exactly the failure that rule exists to
 * prevent.
 */
function resolveRoutePlan(
  instance: WorkflowInstance,
  facts: WorkflowFacts,
  turnId: string,
): { readonly plan: readonly PlannedStep[]; readonly branches: readonly WorkflowBranchRecord[] } {
  const plan: PlannedStep[] = [];
  const branches: WorkflowBranchRecord[] = [];

  const push = (activityId: string): void => {
    const activity = findWorkflowActivity(instance.definition, activityId);
    if (activity === undefined) {
      logger.warn(
        {
          component: "workflow",
          event: "workflow.route.dangling",
          turnId,
          instanceId: instance.instanceId,
          workflowId: instance.workflowId,
          activityId,
        },
        "workflow: a route step names an activity the definition does not declare — skipping it",
      );
      return;
    }
    plan.push({ activity });
  };

  const policyOpen = new Set(instance.definition.policyOpen ?? []);

  workflowRoute(instance.definition).forEach((step, stepIndex: number) => {
    if ("activity" in step) {
      push(step.activity);
      return;
    }
    // LE2-023 — A POLICY SWITCH IS NOT A FACT, so it is not evaluated against
    // the projection. It is read off the instance's PINNED DEFINITION, which
    // means a switch opened (or closed) while a run sat parked does not change
    // what that run does — the same pin that governs which activities a resumed
    // run executes governs which of them the business was offering when the
    // customer said yes. `held` is recorded exactly as a predicate's is, so the
    // operator view can tell a route that took the closed path from one whose
    // customer did not qualify.
    const isPolicyStep = "whenPolicyOpen" in step;
    const held = isPolicyStep
      ? policyOpen.has(step.whenPolicyOpen)
      : evaluateWorkflowPredicate(step.when, facts);
    const arm = held ? step.then : step.otherwise;
    branches.push({
      stepIndex,
      predicate: isPolicyStep
        ? `policy ${step.whenPolicyOpen} ${held ? "open" : "closed"}`
        : describeWorkflowPredicate(step.when),
      held,
      taken: held ? "then" : "otherwise",
      activityIds: [...arm],
    });
    for (const activityId of arm) push(activityId);
  });

  return { plan, branches };
}

/**
 * Run the declared COMPENSATORS for everything this run already executed, in
 * REVERSE order.
 *
 * ── REVERSE, BECAUSE UNDOING IS NOT COMMUTATIVE ──────────────────────────────
 *
 * Later steps were taken against the state earlier steps produced, so undoing
 * them in the order they ran would ask each compensator to reverse a world that
 * has already moved on beneath it. Reverse order is the only one under which
 * every compensator sees exactly the state its own activity created.
 *
 * ── WHAT "COULD NOT BE UNDONE" MEANS, AND WHY IT IS TRACKED ──────────────────
 *
 * Two ways a mutation stays: the author declared it `terminal: "irreversible"`,
 * or its compensator ran and did NOT reach EXECUTE (the kernel refused it, or
 * its executor threw). Both leave the customer changed, and both must reach the
 * `stranded` render rather than the reassuring `compensated` one. A
 * `terminal: "harmless"` step leaves nothing to say — that distinction is the
 * whole reason the marker is two-valued.
 */
async function compensate(args: {
  readonly deps: WorkflowRuntimeDeps;
  readonly instance: WorkflowInstance;
  readonly executedForward: readonly WorkflowActivity[];
  readonly firstStepIndex: number;
  readonly actor: IntentActor;
  readonly ctx: unknown;
  readonly turnId: string;
  readonly now: () => number;
  /** LE2-023 — forwarded so a COMPENSATOR may declare coverage too. A rollback
   *  is a governed mutation like any other and can meet its own confirm band. */
  readonly affirmed: boolean;
}): Promise<{
  readonly steps: readonly WorkflowStepRecord[];
  readonly executed: number;
  readonly stranded: boolean;
  /** LE2-023 — a compensator that ESCALATED. Surfaced to staff, and the run is
   *  stranded either way: the rollback did not happen. */
  readonly escalated: boolean;
}> {
  const { deps, instance, executedForward, actor, ctx, turnId, now } = args;
  const steps: WorkflowStepRecord[] = [];
  let executed = 0;
  let stranded = false;
  let escalated = false;
  let stepIndex = args.firstStepIndex;

  for (const activity of [...executedForward].reverse()) {
    const compensation = activity.compensation;
    if (compensation === undefined) continue;
    if (!("by" in compensation)) {
      if (compensation.terminal === "irreversible") stranded = true;
      continue;
    }

    const compensator = findWorkflowActivity(instance.definition, compensation.by);
    // A build error (`compensator-target-dangling`), so unreachable on a
    // compiled corpus — and STRANDING rather than silently skipping, because a
    // rollback that does not exist leaves the mutation exactly as stranded as a
    // rollback that failed.
    if (compensator === undefined) {
      stranded = true;
      continue;
    }
    const payload = buildActivityPayload(compensator.payload, instance.params);
    if (payload === undefined) {
      stranded = true;
      continue;
    }

    const step = await submitActivity({
      deps,
      instance,
      activity: compensator,
      stepIndex,
      payload,
      actor,
      ctx,
      turnId,
      now,
      role: "compensation",
      compensates: activity.id,
      affirmed: args.affirmed,
    });
    steps.push(step);
    stepIndex += 1;
    if (step.executed) executed += 1;
    else {
      stranded = true;
      if (step.decision === "ESCALATE") escalated = true;
    }
  }

  return { steps, executed, stranded, escalated };
}

/**
 * The honest outcome for a run that stopped part-way — LE2-022.
 *
 * Extracted and named because this is the sentence the customer reads, and
 * getting it wrong is the exact failure the ticket is about: telling somebody
 * nothing happened while a real mutation sits in the store is the same
 * false-negative shape as a false success, pointed the other way.
 *
 *   NOTHING RAN            → `failed`. The v0 meaning, unchanged.
 *   SOMETHING IS STRANDED  → `stranded`, whatever else was undone. One
 *                            un-undone mutation outranks any number of clean
 *                            rollbacks, because it is the half a human has to
 *                            deal with.
 *   EVERYTHING UNDONE      → `compensated`.
 *   ONLY HARMLESS STEPS RAN → `failed`. Materially the customer is where they
 *                            started, so the plain refusal is the honest
 *                            sentence and a rollback notice would be noise
 *                            about nothing.
 */
function failureOutcome(args: {
  readonly executedForward: readonly WorkflowActivity[];
  readonly compensationsExecuted: number;
  readonly stranded: boolean;
  /** LE2-023 — some step was sent to a HUMAN. */
  readonly escalated: boolean;
}): WorkflowRunOutcome {
  // LE2-023 — ESCALATED OUTRANKS EVERY OTHER READING, including `stranded`.
  //
  // The others describe a finished run; this one describes a run whose result is
  // still being decided by a person, and that is the more important thing to say
  // first. It outranks `stranded` specifically because the two can co-occur — an
  // escalated COMPENSATOR leaves a mutation un-undone AND puts the rollback on a
  // staff queue — and of those two facts, "a human is now handling it" is the one
  // that tells the customer what happens next. The stranding is still recorded on
  // the steps and in `compensationsExecuted`, so no operator detail is lost.
  if (args.escalated) return "escalated";
  if (args.executedForward.length === 0) return "failed";
  if (args.stranded) return "stranded";
  return args.compensationsExecuted > 0 ? "compensated" : "failed";
}

/**
 * Run the resolved plan, stopping at the first activity that does not reach
 * EXECUTE, then compensating what already ran.
 *
 * The stop is the fail-closed rule, not an optimisation: carrying on past a step
 * the kernel refused would leave the customer with a partial result they never
 * agreed to. What v1 changes is what happens NEXT — v0 stopped and reported, v1
 * stops, undoes what it can, and says which of those two things happened.
 *
 * A payload that cannot be built stops the run the same way and BEFORE
 * submitting anything — see workflow-params.ts on why a partial payload is the
 * dangerous shape.
 */
async function runRoute(args: {
  readonly deps: WorkflowRuntimeDeps;
  readonly instance: WorkflowInstance;
  readonly plan: readonly PlannedStep[];
  readonly branches: readonly WorkflowBranchRecord[];
  readonly actor: IntentActor;
  readonly ctx: unknown;
  readonly turnId: string;
  readonly now: () => number;
  readonly affirmed: boolean;
}): Promise<SequenceOutcome> {
  const { deps, instance, plan, branches, actor, ctx, turnId, now } = args;
  const steps: WorkflowStepRecord[] = [];
  const executedForward: WorkflowActivity[] = [];
  let failedActivityId: string | undefined;
  let forwardEscalated = false;

  for (const [stepIndex, planned] of plan.entries()) {
    const payload = buildActivityPayload(planned.activity.payload, instance.params);
    if (payload === undefined) {
      failedActivityId = planned.activity.id;
      break;
    }
    const step = await submitActivity({
      deps,
      instance,
      activity: planned.activity,
      stepIndex,
      payload,
      actor,
      ctx,
      turnId,
      now,
      role: "activity",
      affirmed: args.affirmed,
    });
    steps.push(step);
    if (!step.executed) {
      failedActivityId = planned.activity.id;
      forwardEscalated = step.decision === "ESCALATE";
      break;
    }
    executedForward.push(planned.activity);
  }

  if (failedActivityId === undefined) {
    return {
      steps,
      branches,
      outcome: "completed",
      executed: executedForward.length,
      compensationsExecuted: 0,
      planned: plan.length,
    };
  }

  const rollback = await compensate({
    deps,
    instance,
    executedForward,
    firstStepIndex: steps.length,
    actor,
    ctx,
    turnId,
    now,
    affirmed: args.affirmed,
  });

  return {
    steps: [...steps, ...rollback.steps],
    branches,
    outcome: failureOutcome({
      executedForward,
      compensationsExecuted: rollback.executed,
      stranded: rollback.stranded,
      escalated: forwardEscalated || rollback.escalated,
    }),
    failedActivityId,
    executed: executedForward.length,
    compensationsExecuted: rollback.executed,
    planned: plan.length,
    escalated: forwardEscalated || rollback.escalated,
  };
}

export function createWorkflowRuntime(deps: WorkflowRuntimeDeps): WorkflowRuntime {
  const now = deps.now ?? Date.now;
  const newInstanceId = deps.newInstanceId ?? randomUUID;
  /** By INSTANCE ID — the handle that survives a park (see `instanceById`). */
  const instances = new Map<string, WorkflowInstance>();
  /** turnId -> instanceId, for the SELECTING turn's confirm render. */
  const instanceByTurn = new Map<string, string>();
  const anchorDecisions = new Map<string, Decision>();
  /** turnId -> the AUTHORED reason a pre-check refused this turn's workflow. */
  const notices = new Map<string, string>();
  const currentCatalogVersion = deps.currentCatalogVersion ?? (() => CATALOG_VERSION);
  /** ABSENT PORT ⟹ NO FACTS ⟹ every pre-check refuses and every branch takes
   *  `otherwise`. The fail-closed direction, and the reason this is a local
   *  default rather than an `if` at each call site. */
  const projectFacts = async (args: {
    readonly turnId: string;
    readonly actor: IntentActor;
    readonly slots: WorkflowSlots;
  }): Promise<WorkflowFacts> =>
    deps.projectFacts === undefined ? new Map() : deps.projectFacts(args);

  /** Resolved param values, for template filling. */
  const valuesOf = (instance: WorkflowInstance): Map<string, WorkflowParamValue> => {
    const values = new Map<string, WorkflowParamValue>();
    for (const [name, param] of instance.params) {
      if (param.resolved) values.set(name, param.value);
    }
    return values;
  };

  return {
    advertise(allowedIntents: ReadonlyArray<string>): readonly AdvertisedWorkflow[] {
      const authorized = new Set(allowedIntents);
      return deps.workflows
        .filter((workflow) =>
          // CONJUNCTIVE and deterministic — every matcher must hold. The
          // direction is what matters: this reads the roster the capability
          // planners already produced, so auth level, cart state and the ops
          // boundary all stay strictly upstream and a workflow can never widen
          // the surface, only narrow it.
          workflow.matchers.every((matcher) => authorized.has(matcher.capability)),
        )
        .map((workflow) => ({
          id: workflow.id,
          title: workflow.title,
          description: workflow.description,
          // STATED collation — this list lands in the `start_workflow` tool
          // description, which the L1 cache key digests. See workflow-ordering.ts.
          slots: sortedByCodeUnits(workflowSlotNames(workflow)),
          // NOT sorted, unlike the slots: slot names are a SET whose spelling
          // order carries no information, so a stated collation is the only way
          // to keep the cache key stable. Phrasings are a SEQUENCE the author
          // ordered on purpose (production-grounded first), and re-sorting them
          // would destroy that ordering to solve a problem they do not have —
          // the array is already deterministic, straight out of the catalog.
          triggerPhrasings: workflowTriggerPhrasings(workflow),
        }));
    },

    select({ turnId, workflowId, slots, allowedIntents }) {
      // Defense in depth, exactly like the planner's `allowed.has(capability)`:
      // never instantiate a workflow this turn was not offered, even if the
      // model (or a compromised prompt) names one.
      const offered = this.advertise(allowedIntents).some((w) => w.id === workflowId);
      if (!offered) {
        logger.warn(
          {
            component: "workflow",
            event: "workflow.select.rejected",
            turnId,
            workflowId,
          },
          "workflow: a selection named a workflow that is not on this turn's closed surface",
        );
        return undefined;
      }
      const definition = findWorkflow(deps.workflows, workflowId);
      if (definition === undefined) return undefined;

      const resolution = resolveWorkflowParams(definition, {
        ...(deps.claimsFor?.(turnId) === undefined
          ? {}
          : { claims: deps.claimsFor(turnId) as ValidatedClaimValues }),
        slots,
      });

      const instance: WorkflowInstance = {
        instanceId: newInstanceId(),
        workflowId,
        // THE PIN. Read once, at instantiation, and never re-read: that is what
        // makes the run's shape stable and the turn replayable.
        catalogVersion: CATALOG_VERSION,
        definition,
        params: resolution.params,
        unresolved: resolution.unresolved,
        // LE2-023 — the SANITIZED slots, as the parse seam left them. Pinned on
        // the instance like everything else about its shape, so the confirming
        // turn projects its facts from the code the customer actually typed on
        // the SELECTING turn rather than from whatever the resume path happens
        // to carry.
        slots,
        startedAt: new Date(now()).toISOString(),
      };
      evictOldest(instances);
      instances.set(instance.instanceId, instance);
      evictOldest(instanceByTurn);
      instanceByTurn.set(turnId, instance.instanceId);
      logger.info(
        {
          component: "workflow",
          event: "workflow.selected",
          turnId,
          instanceId: instance.instanceId,
          workflowId,
          catalogVersion: instance.catalogVersion,
          activities: definition.activities.length,
          unresolvedParams: instance.unresolved,
        },
        `workflow: selected ${workflowId} (catalog v${instance.catalogVersion})`,
      );
      return instance;
    },

    instanceFor: (turnId: string) => {
      const id = instanceByTurn.get(turnId);
      return id === undefined ? undefined : instances.get(id);
    },

    instanceById: (instanceId: string) => instances.get(instanceId),

    async checkFeasibility({ turnId, actor }) {
      const instance = this.instanceFor(turnId);
      if (instance === undefined) return undefined;
      const prechecks = instance.definition.prechecks ?? [];
      if (prechecks.length === 0) return undefined;

      // ONE projection for every pre-check on the turn. They are all questions
      // about the same customer at the same instant, so asking twice could give
      // two answers and refuse for a reason that was already stale when it was
      // rendered.
      const facts = await projectFacts({ turnId, actor, slots: instance.slots });

      for (const precheck of prechecks) {
        if (evaluateWorkflowPredicate(precheck.predicate, facts)) continue;

        // THE FIRST failure wins and the rest are not evaluated. A customer can
        // act on one specific reason; a list of everything wrong with their
        // account is a wall of text they will read as a refusal anyway, and the
        // authored order is the author's statement of which reason matters most.
        const template = workflowTemplateText(instance.definition, precheck.template);
        const reason =
          template === undefined
            ? // Compiler-guaranteed present (`precheck-template-missing`), so
              // this is reachable only for a definition the compiler never saw —
              // and it is still an honest pt-BR sentence rather than silence.
              "Não consigo fazer isso agora. Já chamei alguém da equipe para te ajudar."
            : renderWorkflowTemplate(template, valuesOf(instance)).trim();

        evictOldest(notices);
        notices.set(turnId, reason);
        logger.info(
          {
            component: "workflow",
            event: "workflow.precheck.failed",
            turnId,
            instanceId: instance.instanceId,
            workflowId: instance.workflowId,
            precheckId: precheck.id,
            predicate: describeWorkflowPredicate(precheck.predicate),
          },
          `workflow: ${instance.workflowId} is infeasible (${precheck.id}) — refusing before any confirm`,
        );
        // A run record with ZERO steps and no kernel exchange: the operator view
        // has to be able to count "we declined to start" apart from "we tried and
        // failed", or a workflow nobody is eligible for reads as a broken one.
        recordWorkflowTrace(turnId, {
          run: {
            instanceId: instance.instanceId,
            workflowId: instance.workflowId,
            catalogVersion: instance.catalogVersion,
            catalogVersionAtRun: currentCatalogVersion(),
            turnId,
            outcome: "infeasible",
            activitiesTotal: 0,
            activitiesExecuted: 0,
            compensationsExecuted: 0,
            precheckFailedId: precheck.id,
            durationMs: 0,
            startedAt: instance.startedAt,
            at: new Date(now()).toISOString(),
          },
          steps: [],
        });
        return {
          instanceId: instance.instanceId,
          workflowId: instance.workflowId,
          precheckId: precheck.id,
          reason,
        };
      }
      return undefined;
    },

    renderNotice: (turnId: string) => notices.get(turnId),

    recordSelectionDecision(turnId: string, decision: Decision): void {
      // LE2-023 — RECORDED FOR EVERY TURN, not only the SELECTING one.
      //
      // It used to return early unless this turn had an instance, which was
      // right while the only consumer was `renderConfirm` (a selecting-turn
      // read). Coverage needs the opposite turn: the customer's "sim" arrives on
      // the CONFIRMING turn, whose id differs, and the kernel's
      // `confirmation:received` basis on THAT turn's resumed anchor decision is
      // the only witnessed evidence the customer affirmed anything. Under the old
      // guard that decision was dropped, so no coverage could ever have been
      // resolved honestly.
      //
      // Recording more turns is harmless: `renderConfirm` still looks its
      // instance up first and ignores anything without one, and the map is the
      // same bounded LRU it always was.
      evictOldest(anchorDecisions);
      anchorDecisions.set(turnId, decision);
    },

    renderConfirm(turnId: string): string | undefined {
      const instanceId = instanceByTurn.get(turnId);
      const instance = instanceId === undefined ? undefined : instances.get(instanceId);
      if (instance === undefined) return undefined;
      // AN UNRESOLVED PARAM MEANS NO AUTHORED CONFIRM, EVER.
      //
      // `renderWorkflowTemplate` leaves an unfilled `{placeholder}` LITERAL —
      // it replaces only names it has values for. Once this string is what the
      // customer actually reads (the responder's `workflowConfirm` seam), a
      // single unresolved param would ship "… ({previousOrderSummary}) …" into
      // a chat window, and the customer would be asked to approve a multi-step
      // run described partly in template syntax.
      //
      // Returning `undefined` degrades to the KERNEL's own sentence, which is
      // always complete and always grounded. That is a strictly better failure
      // than a leaked placeholder, and it is the same fail-closed direction
      // `run()` already takes for the same condition: an unresolved param stops
      // the run before anything is submitted.
      //
      // No production workflow has a claim param today (`claimsFor` is wired in
      // no composition, and the reorder-last definition declares zero params),
      // so this is unreachable on the current corpus — deliberately. It is a
      // guard against the next definition, written while the reason is legible
      // rather than after someone finds the placeholder in a transcript.
      if (instance.unresolved.length > 0) {
        logger.warn(
          {
            component: "workflow",
            event: "workflow.confirm.unresolved_params",
            turnId,
            instanceId: instance.instanceId,
            workflowId: instance.workflowId,
            unresolvedParams: instance.unresolved,
          },
          "workflow: refusing to render an authored confirm with unresolved params — degrading to the kernel's own sentence",
        );
        return undefined;
      }
      const template = workflowTemplateText(
        instance.definition,
        instance.definition.confirm.template,
      );
      if (template === undefined) return undefined;
      const values = valuesOf(instance);
      // The GROUNDED AMOUNT. Quoted verbatim from the kernel's own confirm
      // sentence — the workflow layer never re-derives money, so there is no
      // second computation of a total that could disagree with the one the
      // guard actually enforced.
      const decision = anchorDecisions.get(turnId);
      const confirmation = decision === undefined ? undefined : confirmPromptOf(decision);
      if (confirmation !== undefined) values.set("confirmation", confirmation);
      return renderWorkflowTemplate(template, values).trim();
    },

    renderOutcome(instance: WorkflowInstance, outcome: WorkflowRunOutcome): string {
      // `infeasible` has no outcome template BY DESIGN — a failed pre-check
      // renders that pre-check's OWN reason, which names what is missing, and a
      // generic sentence here would be strictly less useful. It also cannot
      // reach this function: an infeasible workflow never mints an anchor
      // envelope, so the wrapper that calls `renderOutcome` never runs.
      //
      // Otherwise compiler-guaranteed present (`outcome-template-missing` and
      // `compensation-outcome-template-missing`), so the fallback below is
      // reachable only by a definition the compiler never saw — and it is still
      // an honest pt-BR sentence rather than silence.
      const template =
        outcome === "infeasible"
          ? undefined
          : workflowOutcomeText(instance.definition, outcome);
      if (template === undefined) {
        return "Não consegui concluir essa sequência. Já chamei alguém da equipe.";
      }
      return renderWorkflowTemplate(template, valuesOf(instance)).trim();
    },

    async run({ instanceId, turnId, actor, ctx }) {
      const instance = instances.get(instanceId);
      if (instance === undefined) return undefined;

      const runStartedAt = now();

      // THE PIN, ON THE RESUME PATH. The plan is resolved from
      // `instance.definition` — the object captured at SELECTION — and never by
      // looking the workflow id up in `deps.workflows` again. That is what makes
      // "instances pin shape" true across a catalog bump: a definition edited,
      // reordered or removed while this instance sat parked cannot change what
      // this run does. What is NOT pinned is policy: every activity below still
      // meets current-code adjudication, so a guard added since the confirm bites
      // immediately and the run fails closed with an honest render.
      const facts = await projectFacts({ turnId, actor, slots: instance.slots });
      const { plan, branches } = resolveRoutePlan(instance, facts, turnId);

      // A param that did not resolve fails the run BEFORE anything is
      // submitted. There is no admissible way to fill it (see
      // workflow-params.ts), so submitting a partial payload would be a real
      // mutation against a value nobody authored.
      // LE2-023 — THE WITNESSED AFFIRMATION. Read off the kernel's own
      // `confirmation:received` basis on THIS turn's anchor decision, never
      // inferred from the fact that we are running: "we got here, so they must
      // have agreed" is an argument about control flow, and control flow is what
      // a later edit changes without noticing. False makes every declared
      // coverage inert, which is LE2-022's behaviour exactly.
      const affirmed = carriesConfirmationReceipt(anchorDecisions.get(turnId));

      const sequence: SequenceOutcome =
        instance.unresolved.length > 0
          ? unresolvedParamsOutcome(instance, plan, turnId)
          : await runRoute({
              deps,
              instance,
              plan,
              branches,
              actor,
              ctx,
              turnId,
              now,
              affirmed,
            });

      const trace: WorkflowTrace = {
        run: {
          instanceId: instance.instanceId,
          workflowId: instance.workflowId,
          catalogVersion: instance.catalogVersion,
          catalogVersionAtRun: currentCatalogVersion(),
          turnId,
          outcome: sequence.outcome,
          // The RESOLVED PLAN's length, not the definition's activity count: a
          // branchy workflow declares more activities than any single run can
          // take, and a compensator is not a step the run set out to do at all.
          // "1 of 2" has to mean this run, or comparing runs is meaningless.
          activitiesTotal: sequence.planned,
          activitiesExecuted: sequence.executed,
          compensationsExecuted: sequence.compensationsExecuted,
          ...(sequence.failedActivityId === undefined
            ? {}
            : { failedActivityId: sequence.failedActivityId }),
          ...(sequence.branches.length === 0 ? {} : { branches: sequence.branches }),
          durationMs: now() - runStartedAt,
          startedAt: instance.startedAt,
          at: new Date(now()).toISOString(),
        },
        steps: sequence.steps,
      };
      recordWorkflowTrace(turnId, trace);
      return trace;
    },

    selectionCapabilities: () => workflowSelectionKinds(deps.workflows),

    activityCapabilities: () => workflowActivityKinds(deps.workflows),

    close(turnId: string): void {
      const instanceId = instanceByTurn.get(turnId);
      if (instanceId !== undefined) instances.delete(instanceId);
      instanceByTurn.delete(turnId);
      anchorDecisions.delete(turnId);
      notices.delete(turnId);
    },
  };
}
