// Unit tests for the workflow condition primitive (LE2-022).
//
// Two things are being pinned, and only one of them is arithmetic:
//
//   1. every operator's answer, INCLUDING its answer on an absent fact. Absence
//      is the common case in production (a guest has no customer, a fresh
//      session has no cart) and it is the one a "does it compare numbers
//      correctly" test never reaches;
//   2. that FALSE is what absence produces, which is what makes the pre-check
//      path refuse and the branch path take its conservative arm. Every
//      fail-closed claim in this layer rests on that single line.

import { describe, expect, it } from "vitest";
import {
  describeWorkflowPredicate,
  evaluateWorkflowPredicate,
  type WorkflowFacts,
} from "../workflow-predicates.js";

const FACTS: WorkflowFacts = new Map<string, string | number | boolean>([
  ["customerIsAuthenticated", true],
  ["cartHasItems", false],
  ["cartTotalInCentavos", 1500],
  ["previousOrderTotalInCentavos", 0],
]);

/** Shorthand: evaluate against {@link FACTS}. */
function evaluate(
  fact: string,
  op: Parameters<typeof evaluateWorkflowPredicate>[0]["op"],
  value?: string | number | boolean,
): boolean {
  return evaluateWorkflowPredicate(
    { fact, op, ...(value === undefined ? {} : { value }) },
    FACTS,
  );
}

describe("evaluateWorkflowPredicate — presence", () => {
  it("distinguishes a present fact from an absent one", () => {
    expect(evaluate("cartTotalInCentavos", "present")).toBe(true);
    expect(evaluate("cartTotalInCentavos", "absent")).toBe(false);
    expect(evaluate("noSuchFact", "present")).toBe(false);
    expect(evaluate("noSuchFact", "absent")).toBe(true);
  });

  it("treats a FALSE fact as PRESENT — `false` is a value, not a gap", () => {
    // The distinction the whole absent/isFalse pair exists for. Collapsing them
    // would make "the cart is empty" and "we could not read the cart" the same
    // input to a route that decides a governed mutation.
    expect(evaluate("cartHasItems", "present")).toBe(true);
    expect(evaluate("cartHasItems", "absent")).toBe(false);
    expect(evaluate("cartHasItems", "isFalse")).toBe(true);
  });

  it("treats ZERO as present — a total of nothing is still a reading", () => {
    expect(evaluate("previousOrderTotalInCentavos", "present")).toBe(true);
    expect(evaluate("previousOrderTotalInCentavos", "below", 1)).toBe(true);
  });
});

describe("evaluateWorkflowPredicate — booleans", () => {
  it("is strict about `true` and `false`", () => {
    expect(evaluate("customerIsAuthenticated", "isTrue")).toBe(true);
    expect(evaluate("customerIsAuthenticated", "isFalse")).toBe(false);
    expect(evaluate("cartHasItems", "isTrue")).toBe(false);
  });

  it("does NOT read a non-empty number as true", () => {
    // No truthiness anywhere in this layer: `1500` is not `true`, and a route
    // that read it as one would branch on the presence of a total rather than
    // on the fact its author named.
    expect(evaluate("cartTotalInCentavos", "isTrue")).toBe(false);
    expect(evaluate("cartTotalInCentavos", "isFalse")).toBe(false);
  });
});

describe("evaluateWorkflowPredicate — comparisons", () => {
  it("compares numbers, inclusive at the band and exclusive below it", () => {
    expect(evaluate("cartTotalInCentavos", "atLeast", 1500)).toBe(true);
    expect(evaluate("cartTotalInCentavos", "atLeast", 1501)).toBe(false);
    expect(evaluate("cartTotalInCentavos", "below", 1500)).toBe(false);
    expect(evaluate("cartTotalInCentavos", "below", 1501)).toBe(true);
  });

  it("`equals` is strict — a numeric string is not a number", () => {
    // The coercion this deliberately does not do. `"1500" == 1500` would make a
    // money band depend on how a projection happened to spell its value, and the
    // day someone changes a field's type every band would silently stop firing.
    expect(evaluate("cartTotalInCentavos", "equals", 1500)).toBe(true);
    expect(evaluate("cartTotalInCentavos", "equals", "1500")).toBe(false);
  });

  it("a comparison against a non-number is FALSE, not a throw", () => {
    expect(evaluate("cartTotalInCentavos", "atLeast", "muito")).toBe(false);
    expect(evaluate("customerIsAuthenticated", "atLeast", 1)).toBe(false);
  });
});

describe("evaluateWorkflowPredicate — the fail-closed direction", () => {
  it("answers FALSE for EVERY operator over an absent fact, except `absent`", () => {
    // The single property every fail-closed claim in this layer rests on: a
    // pre-check over an unreadable fact refuses the workflow, and a branch over
    // one takes its `otherwise` arm. Asserted across the whole operator set
    // rather than on a sample, because the guarantee is "no operator is an
    // exception".
    const operators = ["present", "isTrue", "isFalse", "equals", "atLeast", "below"] as const;
    for (const op of operators) {
      expect(evaluate("noSuchFact", op, op === "present" ? undefined : 1), op).toBe(
        false,
      );
    }
    expect(evaluate("noSuchFact", "absent")).toBe(true);
  });

  it("is FALSE for a comparing operator with no authored value", () => {
    // A build error (`predicate-malformed`), so unreachable on a compiled
    // corpus. Pinned anyway because the behaviour is what makes that rule worth
    // having: the predicate is permanently false, so a branch that reads as
    // conditional silently is not.
    expect(evaluate("cartTotalInCentavos", "atLeast")).toBe(false);
    expect(evaluate("cartTotalInCentavos", "equals")).toBe(false);
  });
});

describe("describeWorkflowPredicate", () => {
  it("names the fact and the operator, with the authored comparand when there is one", () => {
    expect(
      describeWorkflowPredicate({ fact: "cartTotalInCentavos", op: "atLeast", value: 100000 }),
    ).toBe("cartTotalInCentavos atLeast 100000");
    expect(describeWorkflowPredicate({ fact: "cartHasItems", op: "isTrue" })).toBe(
      "cartHasItems isTrue",
    );
  });

  it("never carries a fact's VALUE — only the declared comparand", () => {
    // These strings ride the workflow trace, which is logged and may be
    // persisted verbatim (`workflow-trace.ts`'s scalars-only rule). The
    // comparand is a catalog literal; the customer's actual cart total is not,
    // and it must not appear because a predicate was described.
    const described = describeWorkflowPredicate({
      fact: "cartTotalInCentavos",
      op: "atLeast",
      value: 100000,
    });
    expect(described).not.toContain("1500");
  });
});
