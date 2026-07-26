/**
 * THE GROUNDED FACT VOCABULARY — LE2-022.
 *
 * The closed set of names a {@link WorkflowPredicate} may read. Every workflow
 * condition in the system — feasibility pre-checks and conditional edges alike —
 * is a predicate over one of these and nothing else, and the compiler rejects
 * any other spelling (`workflow-runtime-shape/predicate-fact-unknown`).
 *
 * # Why this table is where the anti-confabulation guarantee lives
 *
 * Ticket 22 words the condition surface as "claim-predicate preconditions" and
 * "claim truth". Read literally that would mean routing a governed mutation on
 * the claims kernel's per-turn output — and there is no such output to route on:
 * no per-turn claims CAPTURE exists anywhere in this system, a registry claim's
 * validated value is narrowed to its declared `valueBinding` path (which for the
 * order family is a pre-composed pt-BR SUMMARY STRING, not a queryable fact),
 * and `ENABLE_CLAIMS_PIPELINE` is default-OFF in production. A "claim truth"
 * predicate would therefore be either dead or, worse, quietly re-derived from
 * whatever the model said.
 *
 * The owner's ruling for LE2-021 settles the reading and it applies here
 * unchanged: the protected invariant is GROUNDED-NEVER-MODEL-AUTHORED, satisfied
 * through machinery that exists. So a fact is a projection the HOST reads out of
 * the same resolver-assembled `SystemState.ctx` the kernel's own guards are
 * adjudicated against — the `PREVIOUS_ORDER_CTX_KINDS` / `confirmReorderLast`
 * path, generalised. Every member below names a `ctx` field some guard already
 * reads today.
 *
 * That makes the guarantee STRUCTURAL, exactly as it is for values: there is no
 * fact name meaning "ask the model", so a predicate cannot reach model output —
 * not because a reviewer checks, but because no such name compiles. It is the
 * same shape as `WorkflowParamSource`'s two-member union one level over: the
 * forbidden source is unspellable rather than forbidden.
 *
 * # What it costs to add a member
 *
 * Two edits that must land together, and a test that fails when they do not
 * (`workflow-facts.test.ts` asserts the host projects EVERY declared name):
 *
 *   1. a row here, saying which `ctx` field grounds it and why it is worth
 *      routing on;
 *   2. the projection in `apps/api/src/claustrum/workflow/workflow-facts.ts`.
 *
 * A name declared here and not projected would make every predicate over it
 * silently false — the same silent-forever failure `claim-param-type-unknown`
 * exists to stop one layer up — which is why the completeness check is a test
 * and not a convention.
 *
 * # Absence is a value, not an error
 *
 * A fact may be ABSENT: an unauthenticated turn has no customer, a turn with no
 * cart has no total. Absence is reported as absence and the operators are total
 * over it (see `WORKFLOW_PREDICATE_OPERATORS`), so a predicate over a missing
 * fact is deterministically false rather than an exception, a default, or a
 * guess. That is the fail-closed direction: an infeasible-looking workflow is
 * refused honestly, never started hopefully.
 *
 * Pure authored data. No clock, no IO, no decision — the catalog defines.
 */

/** What a fact's projected value is, when it is present. */
export type WorkflowFactKind = "boolean" | "number" | "string"

/** One member of the closed vocabulary. */
export interface WorkflowFactDefinition {
  /** The name a predicate spells. Stable; it appears in traces and diagnostics. */
  readonly name: string
  readonly kind: WorkflowFactKind
  /**
   * The resolver-projected `SystemState.ctx` field this reads, as a DECLARATIVE
   * reference — the same discipline `CapabilityGuardRef.name` uses. The catalog
   * never reaches the runtime; this string is what a reviewer follows to the
   * projection, and what the host's completeness test is written against.
   */
  readonly ctxField: string
  /** Why routing a governed mutation on this fact is worth doing, in one clause. */
  readonly why: string
}

/**
 * Every fact a workflow predicate may name.
 *
 * Deliberately SMALL. Each member is a field some kernel guard already reads, so
 * a workflow branches on the same view of the world the adjudication does; a
 * fact only this table knew about would let a workflow and the guard that
 * governs it disagree about the customer's state, which is the one disagreement
 * a per-activity adjudication design cannot tolerate.
 */
export const WORKFLOW_FACTS: readonly WorkflowFactDefinition[] = [
  {
    name: "customerIsAuthenticated",
    kind: "boolean",
    ctxField: "isAuthenticated",
    why:
      "the auth level every owner-scoped read and every `requireAuthenticated` " +
      "guard already turns on — a workflow that branches on it branches on the " +
      "same fact the kernel will enforce a moment later",
  },
  {
    name: "customerHasPreviousOrder",
    kind: "boolean",
    ctxField: "previousOrderId",
    why:
      "presence of the owner-scoped last-order projection `previousOrderCtxFields` " +
      "stamps (LE2-021). It is the feasibility question for every repeat-purchase " +
      "route, and `confirmReorderLast` already REFUSEs on exactly this absence — " +
      "so a pre-check over it moves that honest sentence to before the confirm",
  },
  {
    name: "previousOrderTotalInCentavos",
    kind: "number",
    ctxField: "previousOrderTotalInCentavos",
    why:
      "the grounded total of that same projection, in centavos (Hard Rule #2). " +
      "Lets a route band on money the way the money guards do, from the same " +
      "number, instead of re-deriving one the workflow layer computed for itself",
  },
  {
    name: "cartHasItems",
    kind: "boolean",
    ctxField: "items",
    why:
      "whether the active cart holds any line item — the fact " +
      "`requireCartItemsForCheckout` REFUSEs on. A route that must not offer " +
      "checkout on an empty cart should read the same field the guard does",
  },
  {
    name: "cartTotalInCentavos",
    kind: "number",
    ctxField: "totalInCentavos",
    why:
      "the active cart's grounded total in centavos — the input to the money " +
      "bands (`confirmLargeTicket`). Present so a conditional edge can take the " +
      "cheap path without the workflow layer ever formatting or summing money",
  },
]

/** Fast membership for the compiler's `predicate-fact-unknown` rule. */
const FACT_NAMES: ReadonlySet<string> = new Set(WORKFLOW_FACTS.map((fact) => fact.name))

/** `true` when `name` is a member of the closed fact vocabulary. */
export function isWorkflowFactName(name: string): boolean {
  return FACT_NAMES.has(name)
}

/** One fact's declaration, or `undefined` for a name the vocabulary omits. */
export function findWorkflowFact(name: string): WorkflowFactDefinition | undefined {
  return WORKFLOW_FACTS.find((fact) => fact.name === name)
}
