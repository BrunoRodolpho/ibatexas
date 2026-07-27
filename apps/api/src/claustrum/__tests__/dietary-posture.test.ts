// dietary-posture.test.ts — BKL-270: the owner-signed posture table, the
// fail-closed boot gate, the read-suppression index, and the two vocabulary nets.
//
// WHAT THIS FILE IS FOR. The posture values are an OWNER RULING (2026-07-27), not an
// implementation detail, so the table below is written out longhand rather than
// derived from the registry: deriving it would make the test agree with whatever the
// code says, which is exactly the property a ratified decision must NOT have. A
// silent flip of any family's posture fails here, loudly, with the family named.

import { describe, expect, it } from "vitest";
import {
  CLAIM_REGISTRY,
  CUSTOMER_CLAIM_SCOPE,
  REGISTRY_SPECS,
  type ClaimPlaneScope,
  type DietaryPosture,
  type RegistryClaimSpec,
} from "../claim-registry.js";
import { OPS_CLAIM_SCOPE } from "../../ops/ops-claim-registry.js";
import {
  assertDietaryPostureDeclared,
  buildDietarySuppressionIndex,
  isDietarySuppressedKey,
  isReadClaimSpec,
} from "../dietary-posture.js";
import {
  detectMedicalEmergencyMarkers,
  isAllergenFamilyAsk,
  isDietQualifiedAsk,
} from "../required-claim-decomposer.js";

// ── The owner-signed table (BKL-270 Phase 1, ratified 2026-07-27) ────────────

const RATIFIED: Readonly<Record<string, DietaryPosture>> = {
  // ABSTAIN — the render names, selects or describes FOOD.
  MENU_ITEM_ALLERGENS: "abstain",
  MENU_ITEM_PRICE: "abstain",
  MENU_ITEM_CONTENTS: "abstain",
  MENU_OVERVIEW: "abstain",
  MENU_DIETARY: "abstain",
  MENU_PAIRINGS: "abstain",
  MENU_SUBSTITUTIONS: "abstain",
  // ANSWER-WITH-ABSTENTION — the customer's own prior act (owner ruling: the fact
  // is theirs to have, the dietary FILTER is not ours to answer).
  CART_CONTENTS: "answer-with-abstention",
  // ANSWER-ANYWAY — clock windows, addresses, zones, money states, status enums.
  STORE_HOURS: "answer-anyway",
  STORE_HOURS_FOR_DATE: "answer-anyway",
  STORE_OPEN_NOW: "answer-anyway",
  STORE_INFO: "answer-anyway",
  DELIVERY_COVERAGE: "answer-anyway",
  DELIVERY_NO_COVERAGE: "answer-anyway",
  COUPON_VALID: "answer-anyway",
  COUPON_INVALID: "answer-anyway",
  ORDER_FULFILLMENT_STAGE: "answer-anyway",
  PAYMENT_STATUS: "answer-anyway",
  RESERVATION_STATUS: "answer-anyway",
  ORDER_HISTORY: "answer-anyway",
  PAYMENT_HISTORY: "answer-anyway",
  CART_EMPTY: "answer-anyway",
};

/** Build a throwaway scope from explicit rows, for the failure-mode tests. */
function scopeOf(specs: Record<string, RegistryClaimSpec>): ClaimPlaneScope {
  return { types: Object.keys(specs), specs };
}

/** A minimal legal read spec. */
function readSpec(
  key: string,
  dietaryPosture: DietaryPosture,
  falsifierKey?: string,
): RegistryClaimSpec {
  return {
    kind: "read_claim",
    dietaryPosture,
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key,
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    ...(falsifierKey === undefined
      ? {}
      : {
          falsifierComplete: true,
          falsifiers: [
            {
              key: falsifierKey,
              ownershipPolicy: "not_applicable" as const,
              freshnessPolicy: "must_read_this_turn" as const,
              sourceIntegrity: "structured" as const,
              provenancePolicy: "preserve" as const,
            },
          ],
        }),
  };
}

describe("BKL-270 — the ratified posture table", () => {
  it("declares a posture for EVERY read claim type, and none for the action claim", () => {
    const reads: string[] = [];
    const actions: string[] = [];
    for (const type of CLAIM_REGISTRY) {
      const spec = REGISTRY_SPECS[type];
      if (isReadClaimSpec(spec)) reads.push(type);
      else actions.push(type);
    }
    // The registry is the authority — not the audit's 18 families, not my count.
    expect(reads).toHaveLength(22);
    expect(actions).toEqual(["PURCHASE_COMPLETED"]);
    expect(Object.keys(RATIFIED).sort()).toEqual([...reads].sort());
  });

  it("matches the owner-signed value for every family (a silent flip fails here)", () => {
    for (const [type, expected] of Object.entries(RATIFIED)) {
      const spec = REGISTRY_SPECS[type as keyof typeof REGISTRY_SPECS];
      expect(isReadClaimSpec(spec), `${type} must be a read spec`).toBe(true);
      if (!isReadClaimSpec(spec)) continue;
      expect(spec.dietaryPosture, `${type} posture drifted from the owner ruling`).toBe(
        expected,
      );
    }
  });

  it("keeps the counts the owner signed: 7 abstain / 14 answer-anyway / 1 answer-with-abstention", () => {
    const tally: Record<string, number> = {};
    for (const posture of Object.values(RATIFIED)) {
      tally[posture] = (tally[posture] ?? 0) + 1;
    }
    expect(tally).toEqual({
      abstain: 7,
      "answer-anyway": 14,
      "answer-with-abstention": 1,
    });
  });

  it("gives CART_CONTENTS and its complement CART_EMPTY OPPOSING postures on DISTINCT keys", () => {
    // The pair is the sharpest argument for a per-SPEC field, and it is only
    // enforceable because the two use different evidence keys.
    const contents = REGISTRY_SPECS.CART_CONTENTS;
    const empty = REGISTRY_SPECS.CART_EMPTY;
    expect(isReadClaimSpec(contents) && contents.dietaryPosture).toBe(
      "answer-with-abstention",
    );
    expect(isReadClaimSpec(empty) && empty.dietaryPosture).toBe("answer-anyway");
    expect(contents.requiredEvidence[0]?.key).not.toBe(empty.requiredEvidence[0]?.key);
  });
});

describe("BKL-270 — the fail-closed boot gate", () => {
  it("PASSES on the real customer registry", () => {
    expect(() => assertDietaryPostureDeclared(CUSTOMER_CLAIM_SCOPE, "customer")).not.toThrow();
  });

  it("PASSES on the real ops plane scope (its 3 read specs are bound too)", () => {
    expect(() => assertDietaryPostureDeclared(OPS_CLAIM_SCOPE, "ops")).not.toThrow();
  });

  // ── REVERT-TO-RED: the gate's whole reason to exist ───────────────────────
  it("REFUSES a read spec with NO posture, naming the offending type", () => {
    const undeclared = { ...readSpec("k:one", "abstain") } as Record<string, unknown>;
    delete undeclared.dietaryPosture;
    const scope = scopeOf({ GOOD: readSpec("k:two", "answer-anyway"), BAD: undeclared as unknown as RegistryClaimSpec });
    expect(() => assertDietaryPostureDeclared(scope, "test")).toThrow(/"BAD"/);
    expect(() => assertDietaryPostureDeclared(scope, "test")).toThrow(/dietaryPosture/);
  });

  it("REFUSES a posture outside the legal three", () => {
    const bogus = { ...readSpec("k:one", "abstain"), dietaryPosture: "answer-sometimes" };
    expect(() =>
      assertDietaryPostureDeclared(scopeOf({ ODD: bogus as unknown as RegistryClaimSpec }), "test"),
    ).toThrow(/answer-sometimes/);
  });

  it("REFUSES a scope with ZERO read specs (non-vacuity)", () => {
    const actionOnly: RegistryClaimSpec = {
      kind: "action_claim",
      minSourceIntegrity: "structured",
      requiredEvidence: [
        {
          key: "act",
          ownershipPolicy: "not_applicable",
          freshnessPolicy: "must_read_this_turn",
          sourceIntegrity: "structured",
          provenancePolicy: "preserve",
        },
      ],
      customerScoped: false,
    };
    expect(() =>
      assertDietaryPostureDeclared(scopeOf({ ACT: actionOnly }), "test"),
    ).toThrow(/ZERO read specs/);
  });

  it("REFUSES when `types` does not cover `specs` (the gate would silently under-inspect)", () => {
    // The vacuity trap in its realistic form: a type present in `specs` but missing
    // from `types` is never iterated, so its posture is never checked.
    const scope: ClaimPlaneScope = {
      types: ["SEEN"],
      specs: {
        SEEN: readSpec("k:seen", "answer-anyway"),
        HIDDEN: readSpec("k:hidden", "abstain"),
      },
    };
    expect(() => assertDietaryPostureDeclared(scope, "test")).toThrow(
      /inspected 1 read spec\(s\) but the scope declares 2/,
    );
  });

  it("REFUSES two read types that SHARE an evidence key with different postures", () => {
    const scope = scopeOf({
      ONE: readSpec("shared:key", "abstain"),
      TWO: readSpec("shared:key", "answer-anyway"),
    });
    expect(() => assertDietaryPostureDeclared(scope, "test")).toThrow(/shared:key/);
    expect(() => assertDietaryPostureDeclared(scope, "test")).toThrow(
      /DIFFERENT dietary postures/,
    );
  });

  it("REFUSES an abstaining key that is ALSO a falsifier (suppression would create a soundness hole)", () => {
    // The dangerous clause: suppressing this key would remove a demotion signal and
    // make OTHER's claim MORE likely to validate.
    const scope = scopeOf({
      ABSTAINER: readSpec("menu:thing", "abstain"),
      OTHER: readSpec("other:key", "answer-anyway", "menu:thing"),
    });
    expect(() => assertDietaryPostureDeclared(scope, "test")).toThrow(/soundness hole/);
    expect(() => assertDietaryPostureDeclared(scope, "test")).toThrow(/OTHER/);
  });

  it("names the PLANE in its errors so an ops failure is not read as a customer one", () => {
    const undeclared = { ...readSpec("k:one", "abstain") } as Record<string, unknown>;
    delete undeclared.dietaryPosture;
    expect(() =>
      assertDietaryPostureDeclared(scopeOf({ BAD: undeclared as unknown as RegistryClaimSpec }), "ops"),
    ).toThrow(/\[ops claim registry\]/);
  });
});

describe("BKL-270 — the read-suppression index", () => {
  const index = buildDietarySuppressionIndex();

  it("suppresses exactly the keys required only by ABSTAINING families", () => {
    expect([...index].sort()).toEqual([
      "allergens",
      "menu:dietary",
      "menu:item_contents",
      "menu:item_price",
      "menu:overview",
      "menu:pairings",
      "menu:substitutions",
    ]);
  });

  it("does NOT suppress the answer-with-abstention cart read", () => {
    // If this ever flips, the owner's third posture has been silently downgraded to
    // a plain abstain and the customer stops seeing their own cart.
    expect(index.has("cart_contents")).toBe(false);
  });

  it("does NOT suppress any answer-anyway family", () => {
    for (const key of [
      "schedule:store_hours",
      "schedule:store_open_now",
      "store:info",
      "delivery:coverage",
      "coupon:valid",
      "payment_status",
      "order_history",
      "cart_empty",
    ]) {
      expect(isDietarySuppressedKey(key, index), `${key} must not be suppressed`).toBe(
        false,
      );
    }
  });

  it("matches PER-RESOURCE runtime keys, not just the declared base", () => {
    // menu:item_price is perResourceKey — the runtime key carries the product id, so
    // a plain set lookup would miss every real read.
    expect(isDietarySuppressedKey("menu:item_price:prod_brownie", index)).toBe(true);
    expect(isDietarySuppressedKey("menu:dietary:vegetariano", index)).toBe(true);
    expect(isDietarySuppressedKey("payment_status:ord_1", index)).toBe(false);
  });

  it("does not let a base key swallow a longer sibling name", () => {
    // The trailing colon in the prefix test is what stops this.
    expect(isDietarySuppressedKey("menu:item_price_history", index)).toBe(false);
  });
});

describe("BKL-270 — the two vocabulary nets", () => {
  const DIET_NAMING = [
    // allergen family (NET A)
    "sou alérgico a amendoim, o que tem?",
    "isso tem glúten?",
    "tem lactose nesse doce?",
    "esse prato contém soja?",
    // the BKL-270 additions (NET B only)
    "sou diabético, o que vocês têm?",
    "sou diabetica, pode ser?",
    "esse molho tem açúcar?",
    "tem muito acucar nisso?",
    "preciso controlar a glicemia",
    "tomo insulina todos os dias",
    "sou celíaco",
    "tenho celiaquia",
    "sou intolerante a frutose",
    "tenho intolerância a frutose",
  ];

  it("NET A ⊆ NET B — every allergen ask is a diet ask", () => {
    for (const text of DIET_NAMING) {
      if (isAllergenFamilyAsk(text)) {
        expect(isDietQualifiedAsk(text), `NET A ⊄ NET B on: ${text}`).toBe(true);
      }
    }
  });

  it("recognises every diet-naming phrasing", () => {
    for (const text of DIET_NAMING) {
      expect(isDietQualifiedAsk(text), `missed: ${text}`).toBe(true);
    }
  });

  it("leaves the ROUTE guard's net UNCHANGED — the new vocabulary is NET B only", () => {
    // This is the whole reason there are two nets: widening NET A would push these
    // turns off classify-only and onto the model path for no safety gain.
    for (const text of [
      "sou diabético, o que vocês têm?",
      "sou celíaco",
      "esse molho tem açúcar?",
      "tenho intolerância a frutose",
    ]) {
      expect(isAllergenFamilyAsk(text), `NET A must NOT widen: ${text}`).toBe(false);
      expect(isDietQualifiedAsk(text)).toBe(true);
    }
  });

  it("does NOT fire on the vocabulary the sweep REJECTED", () => {
    // Each of these is a measured or reasoned false positive from the Phase-1 sweep.
    for (const text of [
      "anota que é sem cebola, por favor", // bare `sem ` — 7/8 corpus hits were these
      "põe uma nota no meu pedido, sem picles",
      "cpf 12345678900, sem pontuação mesmo",
      "quero um ketchup extra", // `keto` inside ketchup
      "me vê uma coca zero", // `zero` — the live store already sells Coca-Cola
      "tem maionese light?", // `light`
      "estou de dieta, quero algo leve", // `diet`/`dieta` — a preference, not a restriction
      "esse atraso é intolerável", // the `intoler` STEM trap
      "tem opção vegetariana?", // MENU_DIETARY's own subject must never abstain
      "tem prato vegano?",
    ]) {
      expect(isDietQualifiedAsk(text), `false positive on: ${text}`).toBe(false);
    }
  });

  it("stays DISJOINT from the medical-emergency router", () => {
    // The ruling's standing constraint: naming a diet is not active distress, and
    // BKL-143/123/184 ratified honest self-report over a handoff for every mention.
    for (const text of DIET_NAMING) {
      expect(detectMedicalEmergencyMarkers(text), `emergency fired on: ${text}`).toEqual(
        [],
      );
    }
    // …and the emergency net still fires on real distress, so the check is not vacuous.
    expect(detectMedicalEmergencyMarkers("socorro, estou passando mal")).toEqual([
      "medical-emergency",
    ]);
  });
});
