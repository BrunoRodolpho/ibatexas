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
// a workflow, because it is the same kernel over the same guards. A workflow
// confirm does NOT pre-authorize a step's own confirm.
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
  readonly adjudicateActivity: (envelope: IntentEnvelope) => Promise<Decision>;
  /** Dispatch an EXECUTE-d activity through the real tool registry. */
  readonly dispatchActivity: (envelope: IntentEnvelope, ctx: unknown) => Promise<unknown>;
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
}): Promise<WorkflowStepRecord> {
  const { deps, instance, activity, stepIndex, payload, actor, ctx, turnId, now } = args;
  const stepStartedAt = now();

  const envelope = buildEnvelope({
    kind: activity.capability,
    payload,
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
  const decision = await deps.adjudicateActivity(envelope);
  const decisionKind = String((decision as { kind?: unknown }).kind ?? "UNKNOWN");
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

  workflowRoute(instance.definition).forEach((step, stepIndex: number) => {
    if ("activity" in step) {
      push(step.activity);
      return;
    }
    const held = evaluateWorkflowPredicate(step.when, facts);
    const arm = held ? step.then : step.otherwise;
    branches.push({
      stepIndex,
      predicate: describeWorkflowPredicate(step.when),
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
}): Promise<{
  readonly steps: readonly WorkflowStepRecord[];
  readonly executed: number;
  readonly stranded: boolean;
}> {
  const { deps, instance, executedForward, actor, ctx, turnId, now } = args;
  const steps: WorkflowStepRecord[] = [];
  let executed = 0;
  let stranded = false;
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
    });
    steps.push(step);
    stepIndex += 1;
    if (step.executed) executed += 1;
    else stranded = true;
  }

  return { steps, executed, stranded };
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
}): WorkflowRunOutcome {
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
}): Promise<SequenceOutcome> {
  const { deps, instance, plan, branches, actor, ctx, turnId, now } = args;
  const steps: WorkflowStepRecord[] = [];
  const executedForward: WorkflowActivity[] = [];
  let failedActivityId: string | undefined;

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
    });
    steps.push(step);
    if (!step.executed) {
      failedActivityId = planned.activity.id;
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
  });

  return {
    steps: [...steps, ...rollback.steps],
    branches,
    outcome: failureOutcome({
      executedForward,
      compensationsExecuted: rollback.executed,
      stranded: rollback.stranded,
    }),
    failedActivityId,
    executed: executedForward.length,
    compensationsExecuted: rollback.executed,
    planned: plan.length,
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
      const facts = await projectFacts({ turnId, actor });

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
      if (!instanceByTurn.has(turnId)) return;
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
      const facts = await projectFacts({ turnId, actor });
      const { plan, branches } = resolveRoutePlan(instance, facts, turnId);

      // A param that did not resolve fails the run BEFORE anything is
      // submitted. There is no admissible way to fill it (see
      // workflow-params.ts), so submitting a partial payload would be a real
      // mutation against a value nobody authored.
      const sequence: SequenceOutcome =
        instance.unresolved.length > 0
          ? unresolvedParamsOutcome(instance, plan, turnId)
          : await runRoute({ deps, instance, plan, branches, actor, ctx, turnId, now });

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
