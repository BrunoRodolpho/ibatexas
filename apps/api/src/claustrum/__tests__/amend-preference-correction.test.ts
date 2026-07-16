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

vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    listByCustomer: (customerId: string, opts?: unknown) => orderListByCustomer(customerId, opts),
  }),
}));

const { referencesExistingOrder, correctAmendPreference, CART_TO_AMEND_KIND } = await import(
  "../amend-preference-correction.js"
);

beforeEach(() => {
  orderListByCustomer = async () => ({ orders: [], count: 0 });
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
