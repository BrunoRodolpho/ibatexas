// PROJECTING THE GROUNDED FACTS a workflow predicate reads (LE2-022).
//
// The host half of `packages/catalog/src/workflows/facts.ts`. The catalog
// DECLARES the closed vocabulary — the names, their kinds, and which resolver
// field grounds each — and this module reads those fields out of an assembled
// `SystemState.ctx` and hands back the map `workflow-predicates.ts` evaluates
// against.
//
// ── WHY IT PROJECTS FROM `ctx` AND NOT FROM ANYWHERE ELSE ────────────────────
//
// Because `ctx` is what the KERNEL'S OWN GUARDS are adjudicated against.
// `requireCartItemsForCheckout` reads `ctx.items`; `confirmLargeTicket` reads
// `ctx.totalInCentavos`; `confirmReorderLast` reads the `previousOrder*` fields
// `previousOrderCtxFields` stamps. A workflow that branched on a second,
// separately-derived view of the customer's state could route one way while the
// guard governing that very step reasoned the other — and per-activity
// adjudication is the whole design, so that disagreement is the one this layer
// cannot tolerate. Same projection, same numbers, same answer.
//
// It is also where the anti-confabulation property becomes real rather than
// asserted: {@link projectWorkflowFacts} takes a ctx and returns a map. There is
// no model port here either, and every value in the result came out of the
// resolver.
//
// ── WHY IT IS TOTAL, AND SILENT ABOUT WHAT IT CANNOT SEE ─────────────────────
//
// A missing or wrong-typed ctx field yields an ABSENT fact, never a default and
// never a throw. Absence is a first-class predicate answer (see
// `workflow-predicates.ts`), and it is the fail-closed one: a pre-check over a
// fact nobody could establish refuses the workflow honestly rather than starting
// it hopefully. Throwing instead would turn "we could not read the cart" into a
// 500 on a conversational turn, which is strictly worse than an honest refusal.
//
// Pure: no clock, no RNG, no IO, no model. The IO that produces `ctx` is the
// resolver's, upstream.

import { WORKFLOW_FACTS } from "@ibatexas/catalog";
import type { WorkflowFactValue, WorkflowFacts } from "./workflow-predicates.js";

/** The assembled ctx a fact is read from — structurally, as the resolver leaves it. */
export type WorkflowFactSource = Readonly<Record<string, unknown>>;

/**
 * Read ONE declared fact out of a ctx field.
 *
 * Two of the five facts are DERIVED rather than copied, and both derivations are
 * here rather than in the catalog because they are statements about the
 * resolver's data shapes, which the catalog cannot see:
 *
 *   `customerHasPreviousOrder` — presence of `previousOrderId`, as a boolean.
 *     The id itself is deliberately NOT a fact: an identifier is the one value
 *     class this system never lets anything upstream of the database author or
 *     compare, and a predicate over one would be a comparison against a literal
 *     somebody typed into a catalog file.
 *   `cartHasItems` — a non-empty `items` ARRAY, as a boolean. The array is not a
 *     scalar and could not be a fact value; what a route can act on is whether
 *     there is anything in the cart, which is also exactly what
 *     `requireCartItemsForCheckout` decides on.
 *
 * The rest are read straight through, and anything that is not a finite scalar
 * of the declared kind reads as ABSENT.
 */
function readFact(name: string, ctxField: string, ctx: WorkflowFactSource): WorkflowFactValue | undefined {
  const raw = ctx[ctxField];

  if (name === "customerHasPreviousOrder") {
    return typeof raw === "string" && raw !== "";
  }
  if (name === "cartHasItems") {
    return Array.isArray(raw) && raw.length > 0;
  }

  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return undefined;
}

/**
 * Project every declared fact from an assembled ctx.
 *
 * Driven by the CATALOG's table rather than by a list here, so adding a fact is
 * one authored row plus (for a derived one) a branch in {@link readFact} — and
 * `workflow-facts.test.ts` fails when the two halves disagree, because a name
 * the catalog declares and this module cannot produce would make every predicate
 * over it silently false forever.
 */
export function projectWorkflowFacts(ctx: WorkflowFactSource | undefined): WorkflowFacts {
  const facts = new Map<string, WorkflowFactValue>();
  if (ctx === undefined) return facts;
  for (const fact of WORKFLOW_FACTS) {
    const value = readFact(fact.name, fact.ctxField, ctx);
    if (value !== undefined) facts.set(fact.name, value);
  }
  return facts;
}
