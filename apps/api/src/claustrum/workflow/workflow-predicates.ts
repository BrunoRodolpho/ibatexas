// PREDICATE EVALUATION — the condition half of the workflow runtime (LE2-022).
//
// The runtime half of `WorkflowPredicate`. Feasibility pre-checks and
// conditional edges both come through here, so there is exactly one definition
// of what a declared condition MEANS — a pre-check that answered a predicate
// differently from a branch would let a workflow refuse to start for a reason
// its own route disagrees with.
//
// ── THE SAME STRUCTURAL GUARANTEE THE PARAM RESOLVER HAS ─────────────────────
//
// {@link evaluateWorkflowPredicate} takes NO model port, no `deps`, no async
// boundary — it is synchronous and pure over a fact map the caller projected
// from grounded state. "The model decided this branch" is not a state this code
// can reach, in the same way "the model invented this parameter" is not one
// `resolveWorkflowParams` can reach. The catalog half is closed too: a predicate
// may only name a member of `WORKFLOW_FACTS`, and the compiler rejects anything
// else (`predicate-fact-unknown`).
//
// ── TOTAL OVER ABSENCE, AND FALSE IS THE SAFE ANSWER ─────────────────────────
//
// A fact can legitimately be missing: an unauthenticated turn has no customer, a
// turn with no cart has no total. Every operator is total over that, and every
// operator except `absent` answers FALSE for a fact it cannot see.
//
// FALSE is the fail-closed direction in both callers, and it is worth being
// explicit about why, because the two look opposite:
//
//   PRE-CHECK — a pre-check must HOLD for the workflow to be feasible, so a
//     missing fact makes the workflow INFEASIBLE and the customer gets the
//     authored reason. The system declines to start something it cannot
//     establish is possible.
//   BRANCH — a missing fact takes the `otherwise` arm. Authors therefore put the
//     acting path in `then` and the conservative path in `otherwise`, which is
//     the convention the fixture corpus follows and the reason `otherwise` is
//     required rather than optional.
//
// There is no "unknown" tri-state, deliberately. A third value would have to be
// resolved somewhere, and every place it could be resolved is a place a
// governed mutation gets decided by a default nobody authored.
//
// Pure: no clock, no RNG, no IO, no model.

import type { WorkflowPredicate } from "@ibatexas/catalog";

/**
 * A projected fact's value. Scalar by construction — the same bound
 * `WorkflowParamValue` puts on a param, and for the same reason: a nested value
 * would need traversal, and traversal is where a path expression grows into a
 * query language.
 */
export type WorkflowFactValue = string | number | boolean;

/**
 * This turn's grounded facts, by declared name.
 *
 * A name the map does not carry is ABSENT, which is a first-class answer rather
 * than an error — see the module doc. The map is produced by
 * `workflow-facts.ts` from the resolver's own projection.
 */
export type WorkflowFacts = ReadonlyMap<string, WorkflowFactValue>;

/** Compare two values numerically, or `undefined` when either is not a number. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Evaluate one declared predicate against this turn's grounded facts.
 *
 * Returns a plain boolean, never a decision: the CALLER decides what a `false`
 * means (an infeasible workflow, or the `otherwise` arm). Keeping the two apart
 * is what lets the pre-check path and the branch path share one definition of
 * truth without sharing a consequence.
 */
export function evaluateWorkflowPredicate(
  predicate: WorkflowPredicate,
  facts: WorkflowFacts,
): boolean {
  const value = facts.get(predicate.fact);

  switch (predicate.op) {
    case "present":
      return value !== undefined;
    case "absent":
      return value === undefined;
    case "isTrue":
      return value === true;
    case "isFalse":
      return value === false;
    case "equals":
      // Strict, and deliberately NOT coercing: `"1000" === 1000` would make a
      // money band depend on how a projection happened to spell its value, which
      // is the class of bug that hides until the day someone changes a field's
      // type and every band silently stops firing.
      return value !== undefined && value === predicate.value;
    case "atLeast": {
      const left = asNumber(value);
      const right = asNumber(predicate.value);
      return left !== undefined && right !== undefined && left >= right;
    }
    case "below": {
      const left = asNumber(value);
      const right = asNumber(predicate.value);
      return left !== undefined && right !== undefined && left < right;
    }
    default:
      // Unreachable for a compiled catalog: `op` is a closed union and the
      // compiler rejects any other spelling. FALSE rather than a throw for the
      // same reason absence is false — an operator this build does not know is
      // one it cannot establish, and a conversational turn must not die over it.
      return false;
  }
}

/**
 * A one-line, PII-free description of a predicate, for the trace and the log.
 *
 * The fact NAME and the operator are internal identifiers and safe to record;
 * the authored comparand is a catalog literal and safe too. The fact's VALUE is
 * not recorded here — a cart total is a customer's money and a workflow trace is
 * logged and may be persisted verbatim (`workflow-trace.ts`'s scalars-only
 * rule). What an operator needs is which way the predicate went, and that rides
 * as a boolean.
 */
export function describeWorkflowPredicate(predicate: WorkflowPredicate): string {
  return predicate.value === undefined
    ? `${predicate.fact} ${predicate.op}`
    : `${predicate.fact} ${predicate.op} ${String(predicate.value)}`;
}
