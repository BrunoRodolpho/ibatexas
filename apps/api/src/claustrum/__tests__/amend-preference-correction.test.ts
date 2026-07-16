/**
 * FE-T09b (BKL-154 live-disproof follow-up) — the deterministic
 * amend-preference correction.
 *
 * Mirrors required-claim-decomposer.test.ts's FE-T17 marker style (both-
 * directions corpora: every phrasing the domain must fire on, AND every
 * ordinary cart-building phrasing that must stay friction-free).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let orderListByCustomer: (
  customerId: string,
  opts?: unknown,
) => Promise<{ orders: ReadonlyArray<{ id: string; fulfillmentStatus: string }>; count: number }> =
  async () => ({ orders: [], count: 0 });
let redisGet: (key: string) => Promise<string | null> = async () => null;
let medusaStoreFetch: (path: string) => Promise<unknown> = async () => ({});
const mockLoggerInfo = vi.fn();

vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    listByCustomer: (customerId: string, opts?: unknown) => orderListByCustomer(customerId, opts),
  }),
  createOrderService: () => ({ getOrder: async () => { throw new Error("not used"); } }),
  createPaymentQueryService: () => ({
    getById: async () => null,
    getActiveByOrderId: async () => null,
    listByOrderId: async () => ({ payments: [], count: 0 }),
  }),
  createCustomerService: () => ({ getById: async () => null }),
  createReservationService: () => ({
    getById: async () => { throw new Error("not found"); },
    listByCustomer: async () => ({ reservations: [], total: 0 }),
  }),
  prisma: { timeSlot: { findUnique: async () => null } },
}));
// `amend-preference-correction.ts` imports `hasNonEmptyActiveCart` from
// resolve-and-assemble.ts, which pulls in @ibatexas/tools too — mocked here
// so the both-states cart check (MAJOR-1) is deterministic in tests.
vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => s,
  getRedisClient: async () => ({ get: (k: string) => redisGet(k) }),
  medusaAdmin: {},
  medusaStore: (path: string) => medusaStoreFetch(path),
  reaisToCentavos: (reais: number) => Math.round(reais * 100),
  searchProducts: async () => ({ products: [] }),
}));
vi.mock("../../lib/logger.js", () => ({
  default: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}));

const { referencesExistingOrder, matchedExistingOrderMarkers, correctAmendPreference, CART_TO_AMEND_KIND } =
  await import("../amend-preference-correction.js");

beforeEach(() => {
  orderListByCustomer = async () => ({ orders: [], count: 0 });
  redisGet = async () => null;
  medusaStoreFetch = async () => ({});
  mockLoggerInfo.mockClear();
});

describe("CART_TO_AMEND_KIND — the 3 watched cart-op kinds", () => {
  it("maps exactly the 3 sibling pairs FE-T09/D-a inverted", () => {
    expect(CART_TO_AMEND_KIND).toEqual({
      "order.item.add": "order.amend.add_item",
      "order.item.update": "order.amend.update_qty",
      "order.item.remove": "order.amend.remove_item",
    });
  });
});

describe("referencesExistingOrder — BKL-154 deterministic markers", () => {
  it("fires on every existing-order phrasing this domain sees", () => {
    for (const text of [
      "meu pedido",
      "quero adicionar uma coca ao meu pedido",
      "MEU PEDIDO", // case-insensitive
      "pedido que eu já fiz",
      "pedido que fiz",
      "pedido que eu fiz",
      "pedido que ja fiz", // accent-insensitive (já/ja)
      "no pedido que eu já fiz, o pedido 910226",
      // Drive F's exact attempt-3 utterance (live disproof, 5/5, cited in
      // the FE-T09b ticket) — the maximally-explicit phrasing that STILL
      // routed to the sibling cart-op kind pre-fix.
      "quero adicionar um refrigerante no pedido que eu já fiz, o pedido 910226",
      "pedido 910226",
      "quero mudar o pedido 4242",
      "adiciona uma coca no pedido",
    ]) {
      expect(referencesExistingOrder(text), text).toBe(true);
    }
  });

  // The adversarial bar (BKL-154's own text, verbatim): ordinary cart-
  // building must stay friction-free. None of these say anything about an
  // EXISTING order — including one that names the word "pedido" while
  // describing placing a brand-new one, the exact false-positive risk a
  // bare /pedido/ substring test would have created.
  it("does NOT fire on ordinary cart-building phrasing (adversarial corpus — friction-free)", () => {
    for (const text of [
      "quero uma coca",
      "adiciona uma coca",
      "coloca uma batata frita",
      "quero pedir uma pizza",
      "me vê um refrigerante",
      "quero fazer um pedido de coca", // says "pedido" — placing a NEW order
      "tira o queijo",
      "aumenta a quantidade",
      "quero uma coca e uma batata",
      "adiciona duas cocas ao carrinho",
      "pode adicionar batata frita?",
    ]) {
      expect(referencesExistingOrder(text), text).toBe(false);
    }
  });

  // "quero cancelar meu pedido" DOES contain "meu pedido" and correctly
  // fires this marker — it's the KIND gate in `correctAmendPreference`
  // (order.cancel isn't in CART_TO_AMEND_KIND) that keeps the correction
  // inert for a cancel utterance, not the marker itself. Pinned separately
  // below (kind-gate tests) rather than folded into the pure-marker corpus.
  it("DOES fire on 'meu pedido' even inside a cancel-shaped sentence (marker is pure text matching; the kind gate does the real disambiguation)", () => {
    expect(referencesExistingOrder("quero cancelar meu pedido")).toBe(true);
  });
});

describe("matchedExistingOrderMarkers — MAJOR-1 explicit-vs-bare marker tracking", () => {
  it("names each explicit marker distinctly", () => {
    expect(matchedExistingOrderMarkers("meu pedido")).toEqual(["meuPedido"]);
    expect(matchedExistingOrderMarkers("pedido que eu já fiz")).toEqual(["pedidoQueFiz"]);
    expect(matchedExistingOrderMarkers("pedido 4242")).toEqual(["pedidoNumero"]);
  });

  it("names the bare marker alone when nothing explicit accompanies it", () => {
    expect(matchedExistingOrderMarkers("adiciona uma coca no pedido")).toEqual(["noPedido"]);
  });

  it("names BOTH when an explicit marker and the bare marker co-occur (Drive F's utterance)", () => {
    const matched = matchedExistingOrderMarkers(
      "quero adicionar um refrigerante no pedido que eu já fiz, o pedido 910226",
    );
    expect(matched).toContain("noPedido");
    expect(matched).toContain("pedidoQueFiz");
    expect(matched).toContain("pedidoNumero");
  });

  it("returns an empty list for ordinary cart-building", () => {
    expect(matchedExistingOrderMarkers("quero uma coca")).toEqual([]);
  });
});

describe("correctAmendPreference — orchestration (kind gate + marker + amendable-order gate)", () => {
  it("re-routes order.item.add -> order.amend.add_item when all conditions hold, threading item + quantity", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "refrigerante", quantity: 2 },
      "quero adicionar um refrigerante no pedido que eu já fiz, o pedido 910226",
      "c1",
    );
    expect(result).toEqual({
      kind: "order.amend.add_item",
      payload: { item: "refrigerante", quantity: 2 },
    });
  });

  it("re-routes order.item.update -> order.amend.update_qty", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "confirmed" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.update",
      { item: "coca", quantity: 3 },
      "aumenta a quantidade da coca no pedido que eu já fiz",
      "c1",
    );
    expect(result?.kind).toBe("order.amend.update_qty");
  });

  it("re-routes order.item.remove -> order.amend.remove_item", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.remove",
      { item: "coca" },
      "tira a coca do meu pedido",
      "c1",
    );
    expect(result?.kind).toBe("order.amend.remove_item");
  });

  it("does NOT re-route a kind this correction doesn't watch (order.cancel)", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    const result = await correctAmendPreference("order.cancel", {}, "meu pedido", "c1");
    expect(result).toBeUndefined();
  });

  it("does NOT re-route ordinary cart-building (no existing-order marker) — the adversarial bar", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "quero uma coca",
      "c1",
    );
    expect(result).toBeUndefined();
  });

  it("does NOT re-route when the utterance is undefined (defensive — no crash on a missing perception.text)", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    const result = await correctAmendPreference("order.item.add", { item: "coca" }, undefined, "c1");
    expect(result).toBeUndefined();
  });

  it("does NOT re-route when the customer has ZERO orders", async () => {
    orderListByCustomer = async () => ({ orders: [], count: 0 });
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "meu pedido",
      "c1",
    );
    expect(result).toBeUndefined();
  });

  it("does NOT re-route when every order is in a non-amendable status (delivered/canceled)", async () => {
    orderListByCustomer = async () => ({
      orders: [
        { id: "o1", fulfillmentStatus: "delivered" },
        { id: "o2", fulfillmentStatus: "canceled" },
      ],
      count: 2,
    });
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "meu pedido",
      "c1",
    );
    expect(result).toBeUndefined();
  });

  it("does NOT re-route order.item.remove when the customer's only order is 'preparing' (checkRemoveOrUpdateQty denies preparing; checkAddItem would have allowed it — the gate is action-specific)", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "preparing" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.remove",
      { item: "coca" },
      "meu pedido",
      "c1",
    );
    expect(result).toBeUndefined();
  });

  it("STILL re-routes order.item.add when the only order is 'preparing' (checkAddItem allows pending/confirmed/preparing)", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "preparing" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "meu pedido",
      "c1",
    );
    expect(result?.kind).toBe("order.amend.add_item");
  });

  it("re-routes even when PONR timing would eventually deny it — the kernel guard chain owns that check, not this gate (fulfillment status alone is the floor here)", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "confirmed" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.update",
      { item: "coca", quantity: 2 },
      "meu pedido",
      "c1",
    );
    expect(result?.kind).toBe("order.amend.update_qty");
  });

  it("fails CLOSED (no re-route) on an order-query error", async () => {
    orderListByCustomer = async () => {
      throw new Error("db down");
    };
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "meu pedido",
      "c1",
    );
    expect(result).toBeUndefined();
  });

  it("threads item via the loose-field fallback chain and DROPS cart-scoped fields (cartId/itemId never carried over to a placed-order amend)", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.remove",
      { cartId: "cart-1", itemId: "line-99", product: "batata frita" },
      "no pedido que eu já fiz",
      "c1",
    );
    expect(result).toEqual({
      kind: "order.amend.remove_item",
      payload: { item: "batata frita" },
    });
  });

  it("omits quantity entirely when the original payload didn't carry one", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    const result = await correctAmendPreference(
      "order.item.remove",
      { item: "coca" },
      "meu pedido",
      "c1",
    );
    expect(result?.payload).toEqual({ item: "coca" });
    expect("quantity" in (result?.payload ?? {})).toBe(false);
  });
});

// ── MAJOR-1 (post-#268 review) — both-states cart-vs-order disambiguation ──
//
// A bare "no pedido" reference is genuinely ambiguous for a MID-CART
// customer: "põe mais uma coca no pedido" plausibly means their IN-PROGRESS
// cart, not a placed order. The 3 explicit markers never have this
// ambiguity (possessive/past-tense/numbered all unambiguously name an
// already-placed order) and re-route regardless of cart state.
describe("correctAmendPreference — MAJOR-1 both-states cart-vs-order disambiguation", () => {
  const AMENDABLE_ORDER = { id: "o1", fulfillmentStatus: "pending" };
  const NON_EMPTY_CART = { id: "cart-1", items: [{ variant_id: "v1", quantity: 1, unit_price: 20 }] };

  function primeAmendableOrderAndCart(): void {
    orderListByCustomer = async () => ({ orders: [AMENDABLE_ORDER], count: 1 });
    redisGet = async (key) => (key === "cart:active:session:sess-1" ? "cart-1" : null);
    medusaStoreFetch = async () => ({ cart: NON_EMPTY_CART });
  }

  it("mid-cart + amendable order + bare 'no pedido' -> NO re-route (favors the cart)", async () => {
    primeAmendableOrderAndCart();
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "põe mais uma coca no pedido",
      "c1",
      "sess-1",
    );
    expect(result).toBeUndefined();
  });

  it("SAME mid-cart + amendable-order state, but 'meu pedido' (explicit) -> STILL re-routes", async () => {
    primeAmendableOrderAndCart();
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "põe mais uma coca no meu pedido",
      "c1",
      "sess-1",
    );
    expect(result?.kind).toBe("order.amend.add_item");
  });

  it("no-cart (or no sessionId at all) + bare 'no pedido' -> re-routes (nothing to favor over the placed order)", async () => {
    orderListByCustomer = async () => ({ orders: [AMENDABLE_ORDER], count: 1 });
    redisGet = async () => null; // no active cart key for this session
    const withSession = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "adiciona uma coca no pedido",
      "c1",
      "sess-empty-cart",
    );
    expect(withSession?.kind).toBe("order.amend.add_item");

    const withoutSession = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "adiciona uma coca no pedido",
      "c1",
      undefined,
    );
    expect(withoutSession?.kind).toBe("order.amend.add_item");
  });

  it("mid-cart with an EMPTY (not non-empty) active cart + bare 'no pedido' -> still re-routes (an empty/checked-out cart doesn't count as 'mid-cart')", async () => {
    orderListByCustomer = async () => ({ orders: [AMENDABLE_ORDER], count: 1 });
    redisGet = async (key) => (key === "cart:active:session:sess-1" ? "cart-1" : null);
    medusaStoreFetch = async () => ({ cart: { id: "cart-1", items: [] } });
    const result = await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "adiciona uma coca no pedido",
      "c1",
      "sess-1",
    );
    expect(result?.kind).toBe("order.amend.add_item");
  });
});

// ── MAJOR-2 (post-#268 review) — audit honesty ──────────────────────────
describe("correctAmendPreference — MAJOR-2 audit log", () => {
  it("logs component:resolver event:amend_preference_correction with from/to kinds + matched markers + customerId WHEN a correction fires", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "meu pedido",
      "c1",
    );
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const [fields] = mockLoggerInfo.mock.calls[0]!;
    expect(fields).toMatchObject({
      component: "resolver",
      event: "amend_preference_correction",
      fromKind: "order.item.add",
      toKind: "order.amend.add_item",
      matchedMarkers: ["meuPedido"],
      customerId: "c1",
    });
  });

  it("does NOT log on pass-through — ordinary cart-building (no marker)", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    await correctAmendPreference("order.item.add", { item: "coca" }, "quero uma coca", "c1");
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("does NOT log on pass-through — a kind this correction doesn't watch", async () => {
    await correctAmendPreference("order.cancel", {}, "meu pedido", "c1");
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("does NOT log on pass-through — no amendable order", async () => {
    orderListByCustomer = async () => ({ orders: [], count: 0 });
    await correctAmendPreference("order.item.add", { item: "coca" }, "meu pedido", "c1");
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("does NOT log on pass-through — MAJOR-1's both-states tie favoring the cart", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "o1", fulfillmentStatus: "pending" }],
      count: 1,
    });
    redisGet = async (key) => (key === "cart:active:session:sess-1" ? "cart-1" : null);
    medusaStoreFetch = async () => ({
      cart: { id: "cart-1", items: [{ variant_id: "v1", quantity: 1, unit_price: 20 }] },
    });
    await correctAmendPreference(
      "order.item.add",
      { item: "coca" },
      "põe mais uma coca no pedido",
      "c1",
      "sess-1",
    );
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
