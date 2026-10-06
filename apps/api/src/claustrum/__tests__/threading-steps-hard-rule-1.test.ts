// R3-S4 — the Hard Rule #1 behavioural pin for the two id-threading steps that
// touch an allergen field.
//
// CLAUDE.md Hard Rule #1: allergens are ALWAYS an explicit array, never inferred.
// Two steps in the threading vocabulary carry that rule:
//
//   `hydrate-product-with-allergens`  — strips whatever the payload carried and
//       refills `allergens` from the RESOLVED CATALOG PRODUCT.
//   `refill-allergen-exclusions`      — strips whatever the payload carried and
//       refills `allergenExclusions` from the customer's SAVED PREFERENCES.
//
// R3-S4 moved the kind gate off both bodies and into the profile table. A
// refactor that quietly reordered, de-duplicated, re-cased, dropped or partially
// filled either array would still satisfy "the field is an array", would still
// satisfy `requireExplicitAllergens` (which only checks the SHAPE), and would
// reach a customer as a WRONG allergen list. So this file pins the array
// BYTE-IDENTICALLY — serialized, not merely deep-equal — against the real
// resolver, on a real amend turn.
//
// Why its own file rather than resolve-and-assemble.test.ts: that suite passes
// UNEDITED across this slice (it is the "what runs" contract R3-S3 was careful
// not to touch), and kind-resolution-profiles.test.ts pins DECLARATIONS with no
// mocks at all. This is the third thing — one rule, driven end-to-end through the
// stage that implements it, named so it can be found when the rule is questioned.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock controls (the minimal subset of the resolver's dependencies these two
//    steps reach: the catalog search and the customer profile read) ───────────
let searchProductsMock: (input: unknown, ctx?: unknown) => Promise<unknown> = async () => ({
  products: [],
});
let customerGetProfileData: (
  cid: string,
) => Promise<{ customerPrefs: { allergenExclusions: string[] } | null }> = async () => ({
  customerPrefs: null,
});

vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => s,
  getRedisClient: async () => ({ get: async () => null }),
  medusaAdmin: {},
  medusaStore: async () => ({}),
  reaisToCentavos: (reais: number) => Math.round(reais * 100),
  searchProducts: (input: unknown, ctx?: unknown) => searchProductsMock(input, ctx),
}));
vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: async () => null,
    listByCustomer: async () => ({ orders: [], count: 0 }),
    findByDisplayId: async () => [],
  }),
  createOrderService: () => ({
    getOrder: async () => {
      throw new Error("order not found");
    },
  }),
  createPaymentQueryService: () => ({
    getById: async () => null,
    getActiveByOrderId: async () => null,
    listByOrderId: async () => ({ payments: [], count: 0 }),
  }),
  createCustomerService: () => ({
    getById: async () => null,
    getProfileData: (cid: string) => customerGetProfileData(cid),
  }),
  createReservationService: () => ({
    getById: async () => {
      throw new Error("not found");
    },
    listByCustomer: async () => ({ reservations: [], total: 0 }),
    checkAvailability: async () => [],
  }),
  prisma: { timeSlot: { findUnique: async () => null } },
}));

const { resolveAndAssemble } = await import("../resolve-and-assemble.js");

/**
 * A deliberately awkward list: three entries, NOT alphabetical, mixed case, with
 * an accent. Any "helpful" normalization — sorting, lowercasing, folding
 * diacritics, de-duplicating — changes the bytes and fails, which is the point.
 */
const CATALOG_ALLERGENS = ["Glúten", "amendoim", "LACTOSE"];

const CUSTOMER_ID = "cus_1";

beforeEach(() => {
  searchProductsMock = async () => ({ products: [] });
  customerGetProfileData = async () => ({ customerPrefs: null });
});

/** The catalog answering with one product that lexically matches "coca". */
const catalogWith = (allergens: unknown): void => {
  searchProductsMock = async () => ({
    products: [
      { id: "prod_1", title: "Coca-Cola 350ml", variants: [{ id: "var_coke" }], allergens },
    ],
  });
};

const amendTurn = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const { payload: out } = await resolveAndAssemble({
    kind: "order.amend.add_item",
    payload,
    customerId: CUSTOMER_ID,
    channel: "web",
    sessionId: "s-1",
    utteranceText: "adiciona uma coca no meu pedido",
  });
  return out as Record<string, unknown>;
};

describe("Hard Rule #1 — hydrate-product-with-allergens (an AMEND turn)", () => {
  it("delivers the catalog's allergens array BYTE-IDENTICALLY", async () => {
    catalogWith(CATALOG_ALLERGENS);

    const out = await amendTurn({ orderId: "ord_1", item: "coca" });

    // Deep equality for a readable diff…
    expect(out.allergens).toEqual(CATALOG_ALLERGENS);
    // …and byte identity for everything deep equality would forgive: order,
    // case, accents, duplicates. NOT reference identity — a defensive copy of
    // the catalog's array would be an improvement, not a regression.
    expect(JSON.stringify(out.allergens)).toBe(JSON.stringify(CATALOG_ALLERGENS));
  });

  it("an EMPTY catalog array survives as an empty array, never as absent", async () => {
    // The distinction Hard Rule #1 rests on: "this product has no allergens" is a
    // POSITIVE fact the catalog asserts, and it must not degrade into "unknown".
    catalogWith([]);

    const out = await amendTurn({ orderId: "ord_1", item: "coca" });

    expect(out.allergens).toEqual([]);
    expect(JSON.stringify(out.allergens)).toBe("[]");
    expect("allergens" in out).toBe(true);
  });

  it("a smuggled model array is stripped, then OVERWRITTEN by the catalog's", async () => {
    // Provenance, not shape: `requireExplicitAllergens` only asks whether the
    // field is an array, so a well-formed adversarial completion is defeated here
    // or nowhere.
    catalogWith(CATALOG_ALLERGENS);

    const out = await amendTurn({
      orderId: "ord_1",
      item: "coca",
      allergens: ["nenhum"],
    });

    expect(JSON.stringify(out.allergens)).toBe(JSON.stringify(CATALOG_ALLERGENS));
  });

  it("a catalog MISS leaves allergens absent — never the model's array", async () => {
    // The strip is unconditional and there is no fall-back to the stripped value,
    // so the kernel REFUSEs rather than trusting an unverified list.
    searchProductsMock = async () => ({ products: [] });

    const out = await amendTurn({ orderId: "ord_1", item: "coca", allergens: [] });

    expect(out.allergens).toBeUndefined();
    expect("allergens" in out).toBe(false);
  });

  it("a non-array catalog value is not passed through as one", async () => {
    // `Array.isArray` is the gate; a product row with a malformed allergens field
    // must leave the payload with NO allergens (→ REFUSE), never a string.
    catalogWith("gluten");

    const out = await amendTurn({ orderId: "ord_1", item: "coca" });

    expect(out.allergens).toBeUndefined();
  });
});

describe("Hard Rule #1 — refill-allergen-exclusions (a PREFERENCES turn)", () => {
  const preferencesTurn = async (
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const { payload: out } = await resolveAndAssemble({
      kind: "customer.preferences.update",
      payload,
      customerId: CUSTOMER_ID,
      channel: "web",
      sessionId: "s-1",
      utteranceText: "sou vegetariano",
    });
    return out as Record<string, unknown>;
  };

  it("delivers the SAVED exclusions BYTE-IDENTICALLY", async () => {
    customerGetProfileData = async () => ({
      customerPrefs: { allergenExclusions: CATALOG_ALLERGENS },
    });

    const out = await preferencesTurn({ dietaryFlags: ["vegetariano"] });

    expect(out.allergenExclusions).toEqual(CATALOG_ALLERGENS);
    expect(JSON.stringify(out.allergenExclusions)).toBe(JSON.stringify(CATALOG_ALLERGENS));
  });

  it("an unrelated preferences edit cannot WIPE a declared allergy", async () => {
    // The reason the refill exists: "sou vegetariano" touches dietaryFlags only,
    // and the wire payload requires allergenExclusions — so without the refill the
    // update would write an empty list over a real allergy.
    customerGetProfileData = async () => ({
      customerPrefs: { allergenExclusions: ["amendoim"] },
    });

    const out = await preferencesTurn({ dietaryFlags: ["vegetariano"] });

    expect(out.allergenExclusions).toEqual(["amendoim"]);
  });

  it("a smuggled model array is stripped, then OVERWRITTEN by the saved list", async () => {
    customerGetProfileData = async () => ({
      customerPrefs: { allergenExclusions: ["amendoim"] },
    });

    const out = await preferencesTurn({
      dietaryFlags: ["vegetariano"],
      allergenExclusions: [],
    });

    expect(out.allergenExclusions).toEqual(["amendoim"]);
  });

  it("a customer with no saved row gets [], and a read ERROR fails closed to []", async () => {
    customerGetProfileData = async () => ({ customerPrefs: null });
    expect((await preferencesTurn({ dietaryFlags: ["vegetariano"] })).allergenExclusions).toEqual(
      [],
    );

    customerGetProfileData = async () => {
      throw new Error("db down");
    };
    const out = await preferencesTurn({ dietaryFlags: ["vegetariano"], allergenExclusions: ["x"] });
    // Fail-closed AND still stripped: the transient error degrades to the same
    // honest REFUSE a genuinely new customer produces, never to the model's value.
    expect(out.allergenExclusions).toEqual([]);
  });
});
