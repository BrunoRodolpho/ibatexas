// Unit tests for the grounded fact projection (LE2-022).
//
// The load-bearing test in this file is the COMPLETENESS one: the catalog
// declares the fact vocabulary and this module produces it, and a name declared
// but not produced would make every predicate over it silently FALSE forever —
// no error, no diagnostic, a pre-check that never fires or a branch permanently
// stuck on one arm. That is the same failure shape `claim-param-type-unknown`
// exists to stop one layer up, and the compiler cannot catch this half: it can
// see the catalog's table but not the host's projection.
//
// So the two halves are checked against each other here, driven off the CATALOG
// table rather than a list repeated in this file — a hand-listed expectation
// would need updating by the same person who forgot the projection.

import { describe, expect, it } from "vitest";
import { WORKFLOW_FACTS } from "@ibatexas/catalog";
import { projectWorkflowFacts } from "../workflow-facts.js";

/** A ctx with every declared fact's source field populated. */
const FULL_CTX: Readonly<Record<string, unknown>> = {
  isAuthenticated: true,
  previousOrderId: "order_abc",
  previousOrderTotalInCentavos: 8900,
  items: [{ variantId: "v1", quantity: 2, priceInCentavos: 4450 }],
  totalInCentavos: 150000,
};

describe("projectWorkflowFacts — vocabulary completeness", () => {
  it("PRODUCES EVERY FACT THE CATALOG DECLARES", () => {
    // THE GATE. Adding a row to `WORKFLOW_FACTS` without adding its projection
    // fails here, by name, in the same change — which is the only place the two
    // halves can be kept honest, because a missing projection is invisible
    // everywhere else.
    const projected = projectWorkflowFacts(FULL_CTX);
    for (const fact of WORKFLOW_FACTS) {
      expect(projected.has(fact.name), fact.name).toBe(true);
    }
    // The other direction: nothing is produced that the catalog does not
    // declare. A stray fact would be one a predicate can never name (the
    // compiler rejects unknown names), so it could only ever be dead weight in
    // a projection that costs a database read.
    for (const name of projected.keys()) {
      expect(
        WORKFLOW_FACTS.some((fact) => fact.name === name),
        name,
      ).toBe(true);
    }
    // The vacuity control: an empty vocabulary would satisfy both loops.
    expect(WORKFLOW_FACTS.length).toBeGreaterThan(0);
  });

  it("projects each fact at its DECLARED kind", () => {
    const projected = projectWorkflowFacts(FULL_CTX);
    for (const fact of WORKFLOW_FACTS) {
      expect(typeof projected.get(fact.name), fact.name).toBe(fact.kind);
    }
  });
});

describe("projectWorkflowFacts — the derived facts", () => {
  it("`customerHasPreviousOrder` is the PRESENCE of the id, never the id itself", () => {
    // The identifier must not become a fact. An id is the one value class this
    // system never lets anything upstream of the database author or compare, and
    // a predicate over one would be a comparison against a literal somebody
    // typed into a catalog file.
    const projected = projectWorkflowFacts(FULL_CTX);
    expect(projected.get("customerHasPreviousOrder")).toBe(true);
    expect([...projected.values()]).not.toContain("order_abc");

    expect(
      projectWorkflowFacts({ ...FULL_CTX, previousOrderId: undefined }).get(
        "customerHasPreviousOrder",
      ),
    ).toBe(false);
    // An empty string is not an order — the shape a partially-written projection
    // row leaves behind.
    expect(
      projectWorkflowFacts({ ...FULL_CTX, previousOrderId: "" }).get(
        "customerHasPreviousOrder",
      ),
    ).toBe(false);
  });

  it("`cartHasItems` reduces the items ARRAY to whether there are any", () => {
    expect(projectWorkflowFacts(FULL_CTX).get("cartHasItems")).toBe(true);
    expect(projectWorkflowFacts({ ...FULL_CTX, items: [] }).get("cartHasItems")).toBe(
      false,
    );
    // `undefined` items — what `buildCartCtx` leaves for a session with no cart
    // — is FALSE and not absent: "there is no cart" and "the cart is empty" are
    // the same answer to the question this fact asks.
    expect(
      projectWorkflowFacts({ ...FULL_CTX, items: undefined }).get("cartHasItems"),
    ).toBe(false);
  });
});

describe("projectWorkflowFacts — totality", () => {
  it("returns an EMPTY map for an absent ctx rather than throwing", () => {
    // A conversational turn must not die because a projection was unavailable.
    // Empty means every predicate is false, which refuses the workflow honestly.
    expect(projectWorkflowFacts(undefined).size).toBe(0);
  });

  it("omits a field of the wrong TYPE rather than coercing it", () => {
    // A `Json` column, a hand-written row, an older projection version: the ctx
    // shape is a hint, not a guarantee. A coerced value would let a money band
    // fire on a string, and the safe answer to "we cannot read this" is that the
    // fact is absent.
    const projected = projectWorkflowFacts({
      ...FULL_CTX,
      totalInCentavos: "150000",
      previousOrderTotalInCentavos: Number.NaN,
    });
    expect(projected.has("cartTotalInCentavos")).toBe(true);
    expect(projected.get("cartTotalInCentavos")).toBe("150000");
    // NaN is not a finite reading of a total.
    expect(projected.has("previousOrderTotalInCentavos")).toBe(false);
  });

  it("omits a fact whose ctx field is missing entirely", () => {
    const projected = projectWorkflowFacts({ isAuthenticated: false });
    expect(projected.get("customerIsAuthenticated")).toBe(false);
    expect(projected.has("cartTotalInCentavos")).toBe(false);
    expect(projected.has("previousOrderTotalInCentavos")).toBe(false);
  });
});
