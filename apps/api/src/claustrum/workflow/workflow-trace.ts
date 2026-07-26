// The WORKFLOW's observability contract (LE2-020).
//
// LE2 Testing Decisions make the funnel's stage records "the funnel's
// observability contract: tier attribution, cache hits, retriever selections,
// and catalog version are asserted by reading the trace". A workflow needs the
// same treatment for a harder question, because a workflow run is the first
// thing in this system that spans MULTIPLE governed mutations behind ONE
// customer decision: when it goes wrong, "the turn refused" is not an answer —
// the operator needs to know which step, out of how many, and what the kernel
// said about it.
//
// ── WHAT THE OPERATOR VIEW NEEDS, AND WHERE EACH FIELD COMES FROM ────────────
//
// The owner's operator view (recorded on the LE2-020 tracker row) asks for four
// things. Each is computable from the two records below, by an aggregator that
// never has to re-run anything:
//
//   success rate    — count {@link WorkflowRunRecord.outcome} by value over a
//                     window. `declined` is deliberately its OWN outcome, not a
//                     failure: a customer saying no is the system working.
//   duration        — {@link WorkflowRunRecord.durationMs}, and per step
//                     {@link WorkflowStepRecord.durationMs}, so a slow run can
//                     be attributed to a step rather than guessed at.
//   top failure     — group the `failed` runs by
//                     {@link WorkflowRunRecord.failedActivityId} and by the
//                     step record's `decision` + `basisCode`. The basis code is
//                     what makes two refusals with the same decision kind
//                     distinguishable, which is exactly the distinction an
//                     operator acts on.
//   step drill-in   — every step of a run, in order, keyed by
//                     `instanceId` + `activityId`.
//
// ── WHY THIS IS NOT A FUNNEL TIER ───────────────────────────────────────────
//
// `funnel-tier.ts` holds a strict ONE-TIER-PER-TURN contract, and the funnel's
// tiers answer one question: which mechanism resolved this turn's PARSE. A
// workflow is orthogonal to that question — a workflow-select turn still
// parses, and it parses through whichever tier would have handled it anyway.
// Inventing a "WORKFLOW" tier would either double-count (the turn already has
// an L1/L2 attribution) or displace a real one, and either way the funnel's
// tier counts would stop meaning what they mean today.
//
// So this follows the precedent `FunnelAliasSeam.recordAliases` set (LE2-025b),
// which files per-turn facts for the trace and explicitly does NOT stamp a
// tier: the workflow records are a SEPARATE per-turn surface that joins to the
// funnel's on `turnId`. A workflow-select turn's tier attribution is therefore
// unchanged — L1 if the selection parse was memoized, L2 otherwise — and that
// is the deliberate decision, not an omission.
//
// ── SHAPE ────────────────────────────────────────────────────────────────────
//
// Scalars only, exactly like `FunnelStageRecord.detail`, for the same reason:
// these are logged and may be persisted verbatim, so nothing here may carry a
// customer's words. Capability kinds, activity ids and workflow ids are
// internal identifiers and safe; a slot VALUE never appears.

import { logger } from "../../lib/logger.js";

/** How a workflow run ended. Mirrors the catalog's `WorkflowOutcome`. */
export type WorkflowRunOutcome = "completed" | "declined" | "failed";

/**
 * One step of one run — the drill-in row.
 *
 * `decision` is the KERNEL's verdict for this activity, recorded whatever it
 * was. A step that refused is not an error in the trace; it is the single most
 * important thing the trace can say, because it is the difference between "the
 * workflow is broken" and "policy correctly stopped it".
 */
export interface WorkflowStepRecord {
  readonly instanceId: string;
  /** 0-based position in the linear sequence — the order the operator reads. */
  readonly stepIndex: number;
  /** The authored activity id (the catalog's join key). */
  readonly activityId: string;
  /** The capability kind adjudicated for this step. */
  readonly capability: string;
  /** The kernel's decision kind: EXECUTE / REFUSE / CONFIRM / ESCALATE / DEFER. */
  readonly decision: string;
  /**
   * The refusal/decision basis code where the decision carried one — what makes
   * two same-kind refusals distinguishable in a "top failure" aggregation.
   */
  readonly basisCode?: string;
  /** `true` only when the kernel said EXECUTE *and* the tool ran without throwing. */
  readonly executed: boolean;
  readonly durationMs: number;
  readonly at: string;
}

/**
 * One run — the per-workflow identity row.
 *
 * `catalogVersion` is the PIN (LE2 Implementation Decision 17: "journey
 * instances pin shape, adjudicate fresh"). It records the catalog the instance
 * was instantiated under, so a run is replayable against the business
 * definition it actually saw. It is NOT a licence: every activity is still
 * adjudicated against current code, so a policy change bites immediately, even
 * mid-run.
 */
export interface WorkflowRunRecord {
  readonly instanceId: string;
  readonly workflowId: string;
  /** The catalog serial this instance was instantiated under — the pin. */
  readonly catalogVersion: number;
  readonly turnId: string;
  readonly outcome: WorkflowRunOutcome;
  readonly activitiesTotal: number;
  readonly activitiesExecuted: number;
  /** The activity that stopped a `failed` run. Absent on any other outcome. */
  readonly failedActivityId?: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly at: string;
}

/** Everything one run produced: the identity row plus its ordered steps. */
export interface WorkflowTrace {
  readonly run: WorkflowRunRecord;
  readonly steps: readonly WorkflowStepRecord[];
}

/**
 * Per-turn workflow trace state, keyed by `turnId` — the same LRU-capped map
 * idiom `funnel-tier.ts` uses, and for the same reason: on the customer plane
 * the conductor is composed once per process, so a per-turn closure does not
 * exist. A turn that opens an instance but never reaches its ingress `finally`
 * (a mid-turn throw) can never leak unboundedly.
 */
const MAX_TRACKED_TURNS = 500;
const turnTraces = new Map<string, WorkflowTrace>();

function evictOldest(map: Map<string, unknown>): void {
  if (map.size < MAX_TRACKED_TURNS) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/** File a completed run's trace under its turn, and emit the queryable log line. */
export function recordWorkflowTrace(turnId: string, trace: WorkflowTrace): void {
  evictOldest(turnTraces);
  turnTraces.set(turnId, trace);
  logger.info(
    {
      component: "workflow",
      event: "workflow.run",
      turnId,
      instanceId: trace.run.instanceId,
      workflowId: trace.run.workflowId,
      catalogVersion: trace.run.catalogVersion,
      outcome: trace.run.outcome,
      activitiesTotal: trace.run.activitiesTotal,
      activitiesExecuted: trace.run.activitiesExecuted,
      ...(trace.run.failedActivityId === undefined
        ? {}
        : { failedActivityId: trace.run.failedActivityId }),
      durationMs: trace.run.durationMs,
      // The steps ride the SAME line rather than one line each: a run is the
      // unit an operator reasons about, and splitting it would make the drill-in
      // a join across log lines that may be interleaved with other turns'.
      steps: trace.steps.map((step) => ({
        stepIndex: step.stepIndex,
        activityId: step.activityId,
        capability: step.capability,
        decision: step.decision,
        ...(step.basisCode === undefined ? {} : { basisCode: step.basisCode }),
        executed: step.executed,
        durationMs: step.durationMs,
      })),
    },
    `workflow: ${trace.run.workflowId} ${trace.run.outcome} — ` +
      `${trace.run.activitiesExecuted}/${trace.run.activitiesTotal} activit(ies) executed ` +
      `(catalog v${trace.run.catalogVersion})`,
  );
}

/** This turn's workflow trace, or `undefined` when no workflow ran. */
export function workflowTrace(turnId: string): WorkflowTrace | undefined {
  return turnTraces.get(turnId);
}

/** INGRESS SEAM — drop this turn's workflow trace state. */
export function closeWorkflowTurn(turnId: string): void {
  turnTraces.delete(turnId);
}
