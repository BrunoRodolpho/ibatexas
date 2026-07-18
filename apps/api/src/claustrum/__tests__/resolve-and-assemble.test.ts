/**
 * resolve-and-assemble — the F4 read side + money-safety entity scoping.
 *
 * Proves the conductor's pre-adjudication resolve stage:
 *   1. reads the per-session LLM-token counter into state.ctx.sessionTokensConsumed
 *      (the F4 read side that closes the loop with emitTurn's write side);
 *   2. loads order/payment entity state scoped to the customer (money-safety: a
 *      different customer's order is NEVER projected into the guards' ctx);
 *   3. fails OPEN to 0 on a counter read error (a Redis blip must not REFUSE);
 *   4. composes with the real F4 guard → REFUSE once the session crosses budget.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { createTokenBudgetGuard, createConfirmGuard } from "@adjudicate/primitives";

// ── Mutable mock controls ───────────────────────────────────────────────────
let redisGet: (key: string) => Promise<string | null> = async () => null;
let orderGetById: (id: string) => Promise<unknown> = async () => null;
let paymentGetById: (id: string) => Promise<unknown> = async () => null;
let paymentGetActiveByOrderId: (orderId: string) => Promise<unknown> = async () => null;
let reservationGetById: (id: string, customerId: string) => Promise<unknown> = async () => {
  throw new Error("not found");
};
// FE-D27 — the availability lookup the reservation slot resolver reuses.
let reservationCheckAvailability: (
  date: string,
  partySize: number,
  time?: string,
) => Promise<Array<{ timeSlotId: string }>> = async () => [];
let timeSlotFindUnique: (args: unknown) => Promise<unknown> = async () => null;
let medusaStoreFetch: (path: string) => Promise<unknown> = async () => ({});
let searchProductsMock: (input: unknown, ctx?: unknown) => Promise<unknown> = async () => ({ products: [] });
let orderListByCustomer: (cid: string, input?: unknown) => Promise<{ orders: unknown[]; count: number }> =
  async () => ({ orders: [], count: 0 });
// FE-T13 — resolveCustomerOrderReference's displayId-reference branch.
let orderFindByDisplayId: (displayId: number) => Promise<Array<{ id: string; customerId: string | null }>> =
  async () => [];
let reservationListByCustomer: (cid: string, opts?: unknown) => Promise<{ reservations: unknown[]; total: number }> =
  async () => ({ reservations: [], total: 0 });
// FE-T14 — customer.preferences.update's allergenExclusions-preservation
// read (createCustomerService().getProfileData).
let customerGetProfileData: (
  cid: string,
) => Promise<{ customerPrefs: { allergenExclusions: string[] } | null }> =
  async () => ({ customerPrefs: null });
// FE-T09 (D-a) — order.amend.update_qty/remove_item's LIVE order-fetch +
// title-match hydration (resolveOrderLineItem), distinct from the stored
// OrderProjection `orderGetById` above.
let orderServiceGetOrder: (
  orderId: string,
  customerId?: string,
) => Promise<{
  order: { items?: Array<{ id: string; title: string; variant_id?: string }> };
  ownershipValid: boolean;
}> = async () => {
  throw new Error("order not found");
};

vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => s,
  getRedisClient: async () => ({ get: (k: string) => redisGet(k) }),
  medusaAdmin: {},
  medusaStore: (path: string) => medusaStoreFetch(path),
  reaisToCentavos: (reais: number) => Math.round(reais * 100),
  searchProducts: (input: unknown, ctx?: unknown) => searchProductsMock(input, ctx),
}));
vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: (id: string) => orderGetById(id),
    listByCustomer: (cid: string, input?: unknown) => orderListByCustomer(cid, input),
    findByDisplayId: (displayId: number) => orderFindByDisplayId(displayId),
  }),
  createOrderService: () => ({
    getOrder: (orderId: string, customerId?: string) => orderServiceGetOrder(orderId, customerId),
  }),
  createPaymentQueryService: () => ({
    getById: (id: string) => paymentGetById(id),
    getActiveByOrderId: (orderId: string) => paymentGetActiveByOrderId(orderId),
    listByOrderId: async () => ({ payments: [], count: 0 }),
  }),
  createCustomerService: () => ({
    getById: async () => null,
    getProfileData: (cid: string) => customerGetProfileData(cid),
  }),
  createReservationService: () => ({
    getById: (id: string, customerId: string) => reservationGetById(id, customerId),
    listByCustomer: (cid: string, opts?: unknown) => reservationListByCustomer(cid, opts),
    checkAvailability: (date: string, partySize: number, time?: string) =>
      reservationCheckAvailability(date, partySize, time),
  }),
  prisma: { timeSlot: { findUnique: (args: unknown) => timeSlotFindUnique(args) } },
}));

// Import AFTER mocks (vitest hoists vi.mock).
const {
  resolveAndAssemble,
  sessionTokenKey,
  resolveCustomerOrderReference,
  parseRelativeOrderDate,
  resolveReservationSlot,
  isAllergenMentionUtterance,
} = await import("../resolve-and-assemble.js");

const BUDGET = 100_000;
const f4Guard = createTokenBudgetGuard<string, unknown, unknown>({
  extractSessionTokens: (state) =>
    (state as { ctx?: { sessionTokensConsumed?: number } }).ctx
      ?.sessionTokensConsumed ?? 0,
  sessionBudget: BUDGET,
  action: "REFUSE",
  userFacing: "limite",
});
const envelope = buildEnvelope({
  kind: "order.note.add",
  payload: {},
  actor: { principal: "llm", sessionId: "s-1" },
  taint: "UNTRUSTED",
  nonce: "n-1",
});

beforeEach(() => {
  redisGet = async () => null;
  orderGetById = async () => null;
  paymentGetById = async () => null;
  paymentGetActiveByOrderId = async () => null;
  reservationGetById = async () => {
    throw new Error("not found");
  };
  reservationCheckAvailability = async () => [];
  timeSlotFindUnique = async () => null;
  medusaStoreFetch = async () => ({});
  searchProductsMock = async () => ({ products: [] });
  orderListByCustomer = async () => ({ orders: [], count: 0 });
  orderFindByDisplayId = async () => [];
  reservationListByCustomer = async () => ({ reservations: [], total: 0 });
  orderServiceGetOrder = async () => {
    throw new Error("order not found");
  };
  customerGetProfileData = async () => ({ customerPrefs: null });
});

describe("resolve-and-assemble — F4 read side", () => {
  it("reads the per-session counter into ctx.sessionTokensConsumed (correct key)", async () => {
    const seen: string[] = [];
    redisGet = async (k) => {
      seen.push(k);
      return k === sessionTokenKey("web", "c1") ? "150000" : null;
    };
    const { ctx } = await resolveAndAssemble({
      kind: "order.note.add",
      payload: { orderId: "o1" },
      customerId: "c1",
      channel: "web",
    });
    expect(ctx.sessionTokensConsumed).toBe(150_000);
    expect(seen).toContain(sessionTokenKey("web", "c1"));
    // And the live guard REFUSEs against the assembled ctx (>= budget).
    expect(f4Guard(envelope, { ctx })?.kind).toBe("REFUSE");
  });

  it("below budget → guard passes (null)", async () => {
    redisGet = async () => "50000";
    const { ctx } = await resolveAndAssemble({
      kind: "order.note.add",
      payload: { orderId: "o1" },
      customerId: "c1",
      channel: "web",
    });
    expect(ctx.sessionTokensConsumed).toBe(50_000);
    expect(f4Guard(envelope, { ctx })).toBeNull();
  });

  it("fails OPEN to 0 when the counter read throws (a Redis blip must not REFUSE)", async () => {
    redisGet = async () => {
      throw new Error("redis down");
    };
    const { ctx } = await resolveAndAssemble({
      kind: "order.note.add",
      payload: { orderId: "o1" },
      customerId: "c1",
      channel: "web",
    });
    expect(ctx.sessionTokensConsumed).toBe(0);
    expect(f4Guard(envelope, { ctx })).toBeNull();
  });
});

describe("resolve-and-assemble — order entity scoping (money-safety)", () => {
  it("projects the order fields when it belongs to the customer", async () => {
    orderGetById = async () => ({
      customerId: "c1",
      paymentMethod: "pix",
      paymentStatus: "paid",
      totalInCentavos: 5000,
      fulfillmentStatus: "confirmed",
    });
    const { ctx } = await resolveAndAssemble({
      kind: "order.note.add",
      payload: { orderId: "o1" },
      customerId: "c1",
      channel: "web",
    });
    expect(ctx.orderId).toBe("o1");
    expect(ctx.paymentStatus).toBe("paid");
    expect(ctx.paymentMethod).toBe("pix");
    expect(ctx.totalInCentavos).toBe(5000);
  });

  it("NEVER projects another customer's order into the ctx", async () => {
    orderGetById = async () => ({
      customerId: "SOMEONE-ELSE",
      paymentStatus: "paid",
      totalInCentavos: 999999,
    });
    const { ctx } = await resolveAndAssemble({
      kind: "order.note.add",
      payload: { orderId: "o1" },
      customerId: "c1",
      channel: "web",
    });
    expect(ctx.orderId).toBe("o1");
    expect(ctx.paymentStatus).toBeNull();
    expect(ctx.totalInCentavos).toBeUndefined();
  });
});

describe("resolve-and-assemble — reservation entity loads", () => {
  it("loads the reservation (customer-scoped) + slot for a cancel", async () => {
    reservationGetById = async (id, customerId) => {
      expect(customerId).toBe("c1");
      return {
        id,
        status: "confirmed",
        partySize: 4,
        timeSlot: { id: "ts1", date: new Date("2026-06-10"), startTime: "19:00" },
      };
    };
    timeSlotFindUnique = async () => ({
      id: "ts1",
      date: new Date("2026-06-10"),
      startTime: "19:00",
      maxCovers: 20,
      reservedCovers: 8,
    });
    const { ctx } = await resolveAndAssemble({
      kind: "reservation.cancel",
      payload: { reservationId: "r1" },
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((ctx.reservation as { status?: string }).status).toBe("confirmed");
    expect((ctx.slot as { maxCovers?: number }).maxCovers).toBe(20);
    expect((ctx.slot as { reservedCovers?: number }).reservedCovers).toBe(8);
  });

  it("NEVER projects an unowned/not-found reservation (getById throws → null → clean REFUSE)", async () => {
    reservationGetById = async () => {
      throw new Error("ownership denied");
    };
    const { ctx } = await resolveAndAssemble({
      kind: "reservation.cancel",
      payload: { reservationId: "r1" },
      customerId: "c1",
      channel: "whatsapp",
    });
    expect(ctx.reservation).toBeNull();
    expect(ctx.slot).toBeNull();
  });

  it("loads the target slot for a create (no reservationId)", async () => {
    timeSlotFindUnique = async () => ({
      id: "ts9",
      date: new Date("2026-06-12"),
      startTime: "20:00",
      maxCovers: 10,
      reservedCovers: 10,
    });
    const { ctx } = await resolveAndAssemble({
      kind: "reservation.create",
      payload: { timeSlotId: "ts9", partySize: 2 },
      customerId: "c1",
      channel: "web",
    });
    expect((ctx.slot as { maxCovers?: number }).maxCovers).toBe(10);
    expect(ctx.reservation).toBeNull();
  });
});

describe("resolve-and-assemble — cart entity loads", () => {
  it("loads the active cart (items + total) keyed by sessionId, payment method from payload", async () => {
    redisGet = async (k) => (k === "cart:active:session:conv-1" ? "cart_abc" : null);
    medusaStoreFetch = async (path) => {
      expect(path).toBe("/store/carts/cart_abc");
      return {
        cart: {
          items: [{ variant_id: "var_1", quantity: 2, unit_price: 89 }],
          total: 178,
          completed_at: null,
        },
      };
    };
    const { ctx } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { paymentMethod: "pix", deliveryType: "pickup" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect(ctx.cartId).toBe("cart_abc");
    expect((ctx.items as Array<{ variantId: string; quantity: number; priceInCentavos: number }>)[0]).toEqual({
      variantId: "var_1",
      quantity: 2,
      priceInCentavos: 8900,
    });
    expect(ctx.totalInCentavos).toBe(17800);
    expect(ctx.paymentMethod).toBe("pix");
    expect(ctx.fulfillment).toBe("pickup");
  });

  it("a completed cart is not projected (treated as no active cart)", async () => {
    redisGet = async () => "cart_done";
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: "2026-06-01" } });
    const { ctx } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: {},
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect(ctx.cartId).toBe("cart_done");
    expect(ctx.items).toBeUndefined();
  });

  it("no active cart key → conservative ctx (items undefined)", async () => {
    redisGet = async () => null;
    const { ctx } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: {},
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect(ctx.cartId).toBeNull();
    expect(ctx.items).toBeUndefined();
  });
});

// ── FE-T12 (team-lead review) — mapCheckoutPaymentMethodWireField ──────────
// The wire→internal rename that lets order.checkout.create's extraction
// schema show the model `payment_method` (snake_case, the field name a live
// calibration proved the 4B reliably produces) while
// `validatePaymentMethod`/`OrderCheckoutCreatePayload` (pack-orders,
// BYTE-UNTOUCHED) keep reading `paymentMethod` unchanged.
describe("resolve-and-assemble — FE-T12 checkout payment_method wire rename", () => {
  it("wire key present: payload.payment_method is renamed to payload.paymentMethod, and the wire key does NOT survive", async () => {
    redisGet = async (k) => (k === "cart:active:session:conv-1" ? "cart_abc" : null);
    medusaStoreFetch = async () => ({
      cart: { items: [{ variant_id: "var_1", quantity: 1, unit_price: 10 }], total: 10, completed_at: null },
    });
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { payment_method: "pix" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { paymentMethod?: string; payment_method?: string };
    expect(p.paymentMethod).toBe("pix");
    expect(payload).not.toHaveProperty("payment_method");
    // End-to-end: the renamed key reaches ctx.paymentMethod (buildCartCtx),
    // the SAME field `validatePaymentMethod` (pack-orders/src/policies.ts)
    // reads — proving the rename actually unblocks the existing guard.
    expect(ctx.paymentMethod).toBe("pix");
  });

  it("internal key absent from the wire: a payload with ONLY payment_method never carries paymentMethod before the rename runs (structural — the extraction schema never declares it)", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: null } });
    const { payload } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { payment_method: "card" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    // The ONLY way `paymentMethod` appears on the resolved payload is via
    // this rename — there is no OTHER path that could have produced it.
    expect((payload as { paymentMethod?: string }).paymentMethod).toBe("card");
  });

  it("no payment_method mentioned: the payload passes through with neither key — never a fabricated method", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: null } });
    const { payload } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: {},
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect(payload).not.toHaveProperty("paymentMethod");
    expect(payload).not.toHaveProperty("payment_method");
  });

  it("defensive: if paymentMethod is ALREADY set (never happens on the real model-facing path), it is never overwritten by a co-present payment_method", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: null } });
    const { payload } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { paymentMethod: "cash", payment_method: "pix" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { paymentMethod?: string }).paymentMethod).toBe("cash");
  });

  it("kind-gated: a DIFFERENT capability's payload carrying payment_method is left alone (the rename is order.checkout.create-only)", async () => {
    orderGetById = async () => ({ id: "order_9", customerId: "c1", fulfillmentStatus: "confirmed" });
    orderListByCustomer = async () => ({ orders: [{ id: "order_9" }], count: 1 });
    const { payload } = await resolveAndAssemble({
      kind: "order.cancel",
      payload: { payment_method: "pix" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { payment_method?: string }).payment_method).toBe("pix");
    expect(payload).not.toHaveProperty("paymentMethod");
  });
});

describe("resolve-and-assemble — FE-T12 checkout delivery_type wire rename", () => {
  it("wire key present: payload.delivery_type is renamed to payload.deliveryType, and the wire key does NOT survive", async () => {
    redisGet = async (k) => (k === "cart:active:session:conv-1" ? "cart_abc" : null);
    medusaStoreFetch = async () => ({
      cart: { items: [{ variant_id: "var_1", quantity: 1, unit_price: 10 }], total: 10, completed_at: null },
    });
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { delivery_type: "pickup" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { deliveryType?: string }).deliveryType).toBe("pickup");
    expect(payload).not.toHaveProperty("delivery_type");
    // End-to-end: the renamed key reaches ctx.fulfillment (buildCartCtx),
    // the SAME field `requireSlotsFilledForCheckout` (pack-orders/src/
    // policies.ts) reads — proving the rename actually unblocks the guard.
    expect(ctx.fulfillment).toBe("pickup");
  });

  it("internal key absent from the wire: a payload with ONLY delivery_type never carries deliveryType before the rename runs (structural — the extraction schema never declares it)", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: null } });
    const { payload } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { delivery_type: "delivery" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    // The ONLY way `deliveryType` appears on the resolved payload is via
    // this rename — there is no OTHER path that could have produced it.
    expect((payload as { deliveryType?: string }).deliveryType).toBe("delivery");
  });

  it("no delivery_type mentioned: the payload passes through with neither key — never a fabricated fulfillment slot", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: null } });
    const { payload } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: {},
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect(payload).not.toHaveProperty("deliveryType");
    expect(payload).not.toHaveProperty("delivery_type");
  });

  it("defensive: if deliveryType is ALREADY set (never happens on the real model-facing path), it is never overwritten by a co-present delivery_type", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: null } });
    const { payload } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { deliveryType: "pickup", delivery_type: "delivery" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { deliveryType?: string }).deliveryType).toBe("pickup");
  });

  it("kind-gated: a DIFFERENT capability's payload carrying delivery_type is left alone (the rename is order.checkout.create-only)", async () => {
    orderGetById = async () => ({ id: "order_9", customerId: "c1", fulfillmentStatus: "confirmed" });
    orderListByCustomer = async () => ({ orders: [{ id: "order_9" }], count: 1 });
    const { payload } = await resolveAndAssemble({
      kind: "order.cancel",
      payload: { delivery_type: "pickup" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { delivery_type?: string }).delivery_type).toBe("pickup");
    expect(payload).not.toHaveProperty("deliveryType");
  });

  it("both wire fields present together: payment_method AND delivery_type both rename independently in the same turn", async () => {
    redisGet = async (k) => (k === "cart:active:session:conv-1" ? "cart_abc" : null);
    medusaStoreFetch = async () => ({
      cart: { items: [{ variant_id: "var_1", quantity: 1, unit_price: 10 }], total: 10, completed_at: null },
    });
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { payment_method: "card", delivery_type: "delivery" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { paymentMethod?: string; deliveryType?: string };
    expect(p.paymentMethod).toBe("card");
    expect(p.deliveryType).toBe("delivery");
    expect(payload).not.toHaveProperty("payment_method");
    expect(payload).not.toHaveProperty("delivery_type");
    expect(ctx.paymentMethod).toBe("card");
    expect(ctx.fulfillment).toBe("delivery");
  });
});

// ── BKL-094 coercion class (team-lead ruling) — VALUE normalization, distinct
//    from the KEY-rename tests above. A closed, deterministic synonym map —
//    never a fuzzy/heuristic match. KEY drift (e.g. `payment` instead of
//    `payment_method`) is NOT in scope here; only VALUE synonyms under the
//    correct key. ──────────────────────────────────────────────────────────
describe("resolve-and-assemble — FE-T12 payment_method/delivery_type VALUE normalization", () => {
  const activeCartWithItems = (): void => {
    redisGet = async (k) => (k === "cart:active:session:conv-1" ? "cart_abc" : null);
    medusaStoreFetch = async () => ({
      cart: { items: [{ variant_id: "var_1", quantity: 1, unit_price: 10 }], total: 10, completed_at: null },
    });
  };

  it.each([
    ["cartão", "card"],
    ["cartao", "card"],
    ["crédito", "card"],
    ["credito", "card"],
    ["débito", "card"],
    ["debito", "card"],
    ["credit", "card"],
    ["debit", "card"],
    ["dinheiro", "cash"],
    // Already-canonical values pass through unchanged (identity entries).
    ["pix", "pix"],
    ["card", "card"],
    ["cash", "cash"],
  ])("payment_method %j normalizes to %j — reaches ctx.paymentMethod (validatePaymentMethod's own field)", async (raw, expected) => {
    activeCartWithItems()
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { payment_method: raw },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { paymentMethod?: string }).paymentMethod).toBe(expected)
    expect(ctx.paymentMethod).toBe(expected)
  })

  it.each([
    ["retirada", "pickup"],
    ["buscar", "pickup"],
    ["entrega", "delivery"],
    // Already-canonical values pass through unchanged (identity entries).
    ["pickup", "pickup"],
    ["delivery", "delivery"],
  ])("delivery_type %j normalizes to %j — reaches ctx.fulfillment (requireSlotsFilledForCheckout's own field)", async (raw, expected) => {
    activeCartWithItems()
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { delivery_type: raw },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { deliveryType?: string }).deliveryType).toBe(expected)
    expect(ctx.fulfillment).toBe(expected)
  })

  it("is case- and whitespace-insensitive (the model's exact casing/spacing varies across turns)", async () => {
    activeCartWithItems()
    const { ctx } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { payment_method: "  CARTÃO  " },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    })
    expect(ctx.paymentMethod).toBe("card")
  })

  it("an UNRECOGNIZED value passes through UNCHANGED — never mapped to null, never dropped (validatePaymentMethod's existing 'invalid' REFUSE path still catches it, unchanged from before this map existed)", async () => {
    redisGet = async () => "cart_abc"
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: null } })
    const { payload } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { payment_method: "boleto" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    })
    expect((payload as { paymentMethod?: string }).paymentMethod).toBe("boleto")
  })

  it("KEY drift is NOT normalized here — a wrong key (payment instead of payment_method) is untouched by this seam entirely (measurement, not repair, per the reason-drift ruling)", async () => {
    redisGet = async () => "cart_abc"
    medusaStoreFetch = async () => ({ cart: { items: [], total: 0, completed_at: null } })
    const { payload } = await resolveAndAssemble({
      kind: "order.checkout.create",
      payload: { payment: "pix" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    })
    expect(payload).not.toHaveProperty("paymentMethod")
    expect((payload as { payment?: string }).payment).toBe("pix")
  })
});

// ── F3/L1 (D-014) — thread resolved ids from ctx onto the executor payload ────
// Without this the tool receives envelope.payload lacking cartId and throws a
// ZodError after the kernel EXECUTEs — the "can't add an item by message" gap.
describe("resolve-and-assemble — L1 payload threading (D-014)", () => {
  const activeCart = () => {
    redisGet = async (k) => (k === "cart:active:session:conv-1" ? "cart_abc" : null);
    medusaStoreFetch = async () => ({
      cart: { items: [{ variant_id: "var_1", quantity: 1, unit_price: 50 }], total: 50, completed_at: null },
    });
  };

  it("injects the session-resolved cartId into a cart-op payload (order.item.add)", async () => {
    activeCart();
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { variantId: "var_1", quantity: 1 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { cartId?: string }).cartId).toBe("cart_abc");
  });

  it("injects cartId for order.checkout.create and order.coupon.apply", async () => {
    for (const kind of ["order.checkout.create", "order.coupon.apply"]) {
      activeCart();
      const { payload } = await resolveAndAssemble({
        kind,
        payload: { paymentMethod: "pix", code: "SAVE10" },
        customerId: "c1",
        channel: "web",
        sessionId: "conv-1",
      });
      expect((payload as { cartId?: string }).cartId).toBe("cart_abc");
    }
  });

  it("never overrides an explicitly-supplied cartId", async () => {
    activeCart();
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { cartId: "cart_explicit", variantId: "var_1", quantity: 1 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { cartId?: string }).cartId).toBe("cart_explicit");
  });

  it("does not inject cartId when no active cart was resolved", async () => {
    redisGet = async () => null;
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { variantId: "var_1", quantity: 1 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { cartId?: string }).cartId).toBeUndefined();
  });

  it("does not inject cartId for an order-by-id kind (order.cancel routes through loadOrderCtx)", async () => {
    activeCart(); // even with an active cart key present…
    const { payload } = await resolveAndAssemble({
      kind: "order.cancel",
      payload: { orderId: "order_1" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    // …order.cancel resolves by orderId (ctx.cartId is null), so no cartId leaks in.
    expect((payload as { cartId?: string }).cartId).toBeUndefined();
  });

  it("injects the identity customerId into a reservation.create payload", async () => {
    const { payload } = await resolveAndAssemble({
      kind: "reservation.create",
      payload: { timeSlotId: "slot_1", partySize: 2 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { customerId?: string }).customerId).toBe("c1");
  });
});

// ── F3/L1 (BKL-061) — NL→variantId resolution for order.item.add ─────────────
// The 4B emits a loose product name (e.g. {item:"coca cola"}) with no variantId;
// resolve it via searchProducts (a READ — resolve stays read-only) so the tool
// schema {cartId,variantId,quantity} is satisfiable.
describe("resolve-and-assemble — NL→variantId (BKL-061)", () => {
  it("resolves a loose product name to variantId + explicit allergens + defaults quantity (BKL-061/067)", async () => {
    searchProductsMock = async () => ({
      products: [
        { id: "prod_1", title: "Coca-Cola 350ml", variants: [{ id: "var_coke" }], allergens: ["gluten"] },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { item: "coca cola" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { variantId?: string; quantity?: number; allergens?: string[] };
    expect(p.variantId).toBe("var_coke");
    expect(p.quantity).toBe(1);
    // BKL-067: the product's EXPLICIT allergen array is injected (Hard Rule #1).
    expect(p.allergens).toEqual(["gluten"]);
  });

  it("injects an empty allergen array for a product with no allergens (still explicit)", async () => {
    searchProductsMock = async () => ({
      products: [{ id: "p2", title: "Água Mineral 500ml", variants: [{ id: "var_water" }], allergens: [] }],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { item: "agua" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { allergens?: string[] }).allergens).toEqual([]);
  });

  it("does not override an explicit variantId", async () => {
    searchProductsMock = async () => ({ products: [{ variants: [{ id: "var_other" }] }] });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { variantId: "var_explicit", quantity: 3 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { variantId?: string; quantity?: number };
    expect(p.variantId).toBe("var_explicit");
    expect(p.quantity).toBe(3);
  });

  it("leaves variantId unset when no product matches (tool REFUSEs honestly)", async () => {
    searchProductsMock = async () => ({ products: [] });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { item: "xyzzy nonexistent" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { variantId?: string }).variantId).toBeUndefined();
  });

  it("swallows a searchProducts error and leaves variantId unset", async () => {
    searchProductsMock = async () => {
      throw new Error("typesense down");
    };
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { item: "coca" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { variantId?: string }).variantId).toBeUndefined();
  });

  // FE-T09b (FE-D17 interim floor, BKL-154 live-drive follow-up) — Typesense's
  // fuzzy ranking is NOT trusted blindly: a NON-EMPTY result with zero lexical
  // relationship to the query is treated exactly like no match at all. Live-
  // demonstrated case: query "xyzzy" still returned A product (some unrelated
  // top hit) — the resolver must refuse to attach that product's variant/
  // allergens rather than guessing. This is DISTINCT from "leaves variantId
  // unset when no product matches" above (an EMPTY result set) — here
  // Typesense returns something, just not anything related.
  it("leaves variantId/allergens unset when the top hit shares NO lexical relationship with the query (arbitrary-match floor, FE-D17 interim)", async () => {
    searchProductsMock = async () => ({
      products: [
        {
          id: "prod_unrelated",
          title: "Costela Bovina Defumada",
          variants: [{ id: "var_costela" }],
          allergens: ["gluten"],
        },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { item: "xyzzy" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { variantId?: string; allergens?: string[] };
    expect(p.variantId).toBeUndefined();
    expect(p.allergens).toBeUndefined();
  });

  it("order.amend.add_item: the same arbitrary-match floor applies (unrelated top hit refused, not attached to the amend target)", async () => {
    searchProductsMock = async () => ({
      products: [
        { id: "prod_unrelated", title: "Costela Bovina Defumada", variants: [{ id: "var_costela" }], allergens: [] },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1", item: "xyzzy" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { variantId?: string; allergens?: string[] };
    expect(p.variantId).toBeUndefined();
    expect(p.allergens).toBeUndefined();
  });

  it("does NOT reject a genuine loose/partial match — a shared token is enough (permissive direction, never over-strict)", async () => {
    searchProductsMock = async () => ({
      products: [
        { id: "prod_coke_zero", title: "Coca-Cola Zero 350ml", variants: [{ id: "var_zero" }], allergens: [] },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      // The customer says just "coca" — a substring of "Coca-Cola", not the
      // full title. The overlap floor must still accept this.
      payload: { item: "coca" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { variantId?: string }).variantId).toBe("var_zero");
  });

  // Review MINOR (post-#268): the overlap floor is permissive by TOKEN/
  // CONTAINMENT, not by fuzzy/stemmed matching — a pt-BR DIMINUTIVE
  // ("coquinha" for "coca") shares no token and no substring with
  // "Coca-Cola" and is refused today, exactly like "xyzzy". This is an
  // ACCEPTED INTERIM COST (a real stemmed/fuzzy match belongs in the
  // search layer itself — FE-D17 — not reimplemented in this resolver-
  // level floor), pinned here explicitly so a future change to
  // hasLexicalOverlap's behavior on diminutives is a conscious choice.
  it("REFUSES a pt-BR diminutive ('coquinha') against its base-form product — accepted interim cost of the token/containment floor, not a genuine-match regression", async () => {
    searchProductsMock = async () => ({
      products: [
        { id: "prod_coke", title: "Coca-Cola 350ml", variants: [{ id: "var_coke" }], allergens: ["gluten"] },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { item: "coquinha" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { variantId?: string; allergens?: string[] };
    expect(p.variantId).toBeUndefined();
    expect(p.allergens).toBeUndefined();
  });
});

// ── FE-T09 (D-a) — the granular post-checkout amend kinds' item hydration ───
//
// order.amend.add_item reuses the EXACT SAME resolveProductForItem path as
// order.item.add (BKL-061/067) — the model's NL `item` reference resolves to
// variantId + the product's EXPLICIT allergens, never the model itself.
// order.amend.update_qty/remove_item resolve the NL reference to a line
// ALREADY on the order (never a catalog-wide guess) via resolveOrderLineItem —
// a LIVE Medusa order fetch + case-insensitive title match, mirroring
// amend-order.ts's existing semantics, yielding a REAL Medusa line-item id
// (never a title stand-in).
describe("resolve-and-assemble — FE-T09 granular amend item hydration", () => {
  it("order.amend.add_item resolves variantId + explicit allergens from the catalog (never model-populated)", async () => {
    searchProductsMock = async () => ({
      products: [{ id: "prod_1", title: "Coca-Cola 350ml", variants: [{ id: "var_coke" }], allergens: ["gluten"] }],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1", item: "coca" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { variantId?: string; allergens?: string[]; quantity?: number };
    expect(p.variantId).toBe("var_coke");
    expect(p.allergens).toEqual(["gluten"]);
    expect(p.quantity).toBe(1);
  });

  it("order.amend.add_item leaves allergens/variantId UNSET when no catalog match — the kernel's requireExplicitAllergens REFUSEs rather than the resolver guessing", async () => {
    searchProductsMock = async () => ({ products: [] });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1", item: "xyzzy nonexistent" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { variantId?: string; allergens?: string[] };
    expect(p.variantId).toBeUndefined();
    expect(p.allergens).toBeUndefined();
  });

  // Review finding (post-#264, MAJOR): the old `needsAllergens =
  // !Array.isArray(out.allergens)` conditional treated ANY array already on
  // the payload — including one smuggled in by an adversarial completion —
  // as "already resolved" and skipped the authoritative fill entirely.
  // requireExplicitAllergens (pack-orders) only checks the SHAPE (is it an
  // array?), never the source, so a smuggled array would have defeated Hard
  // Rule #1 / AC3 silently. These two regressions prove the fix: the
  // resolver's product data always wins, both kinds, both outcomes.
  it("order.item.add: a scripted completion smuggling allergens is OVERWRITTEN by the resolved product's allergens, never the model's (adversarial)", async () => {
    searchProductsMock = async () => ({
      products: [{ id: "prod_1", title: "Coca-Cola 350ml", variants: [{ id: "var_coke" }], allergens: ["gluten"] }],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      // Adversarial: the model schema never exposes `allergens`, but a
      // malformed/adversarial completion could still carry the key.
      payload: { item: "coca", allergens: [] },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { allergens?: string[] }).allergens).toEqual(["gluten"]);
  });

  it("order.amend.add_item: a scripted completion smuggling a FABRICATED allergen claim is OVERWRITTEN by the resolved product's real allergens (adversarial)", async () => {
    searchProductsMock = async () => ({
      products: [{ id: "prod_1", title: "Coca-Cola 350ml", variants: [{ id: "var_coke" }], allergens: ["gluten"] }],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      // Adversarial: the model claims NO allergens (or the wrong ones) —
      // the resolver must never defer to it.
      payload: { orderId: "ord_1", item: "coca", allergens: ["nuts"] },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { allergens?: string[] }).allergens).toEqual(["gluten"]);
  });

  it("order.amend.add_item: a smuggled allergens array does NOT survive when the catalog lookup misses — stripped, never fallen back to, so requireExplicitAllergens still REFUSEs (adversarial + no match)", async () => {
    searchProductsMock = async () => ({ products: [] });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1", item: "xyzzy nonexistent", allergens: [] },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { allergens?: string[] }).allergens).toBeUndefined();
  });

  // FE-D18 — no-match honesty floor for the amend path. When an amend
  // "adiciona X no meu pedido" can't resolve X to a catalog variant, the
  // resolver stamps ctx.amendItemUnresolved so the adopter
  // refuseUnresolvedAmendItemGuard REFUSEs pre-park instead of parking a
  // doomed envelope behind confirmOnAutoResolveGuard's found-implying prompt.
  it("order.amend.add_item: stamps ctx.amendItemUnresolved when the catalog lookup misses (empty result)", async () => {
    searchProductsMock = async () => ({ products: [] });
    const { ctx } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1", item: "xyzzy nonexistent" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect(ctx.amendItemUnresolved).toBe(true);
  });

  it("order.amend.add_item: stamps ctx.amendItemUnresolved when the lexical-overlap floor refuses an unrelated top hit", async () => {
    searchProductsMock = async () => ({
      products: [
        { id: "prod_unrelated", title: "Costela Bovina Defumada", variants: [{ id: "var_costela" }], allergens: [] },
      ],
    });
    const { ctx, payload } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1", item: "xyzzy" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    // The arbitrary hit is refused (variantId unset) AND the honesty flag is set.
    expect((payload as { variantId?: string }).variantId).toBeUndefined();
    expect(ctx.amendItemUnresolved).toBe(true);
  });

  // REVIEW FIX (2026-07-17): the third stamp arm — payload carries NO item name
  // at all (and no variantId) — was implemented but untested.
  it("order.amend.add_item: stamps ctx.amendItemUnresolved when the payload has no item name", async () => {
    searchProductsMock = async () => ({ products: [] });
    const { ctx } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect(ctx.amendItemUnresolved).toBe(true);
  });

  it("order.amend.add_item: does NOT stamp ctx.amendItemUnresolved when the item resolves", async () => {
    searchProductsMock = async () => ({
      products: [{ id: "prod_1", title: "Coca-Cola 350ml", variants: [{ id: "var_coke" }], allergens: ["gluten"] }],
    });
    const { ctx, payload } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1", item: "coca" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { variantId?: string }).variantId).toBe("var_coke");
    expect(ctx.amendItemUnresolved).toBeUndefined();
  });

  it("order.amend.add_item: does NOT stamp when an explicit (non-model) variantId is present — the resume leg carries the resolved variantId", async () => {
    // Even a stale/unrelated catalog hit must not matter: with variantId
    // already present, needsVariant is false and the flag is never stamped.
    searchProductsMock = async () => ({ products: [] });
    const { ctx, payload } = await resolveAndAssemble({
      kind: "order.amend.add_item",
      payload: { orderId: "ord_1", variantId: "var_explicit" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { variantId?: string }).variantId).toBe("var_explicit");
    expect(ctx.amendItemUnresolved).toBeUndefined();
  });

  it("order.item.add (cart sibling): never stamps ctx.amendItemUnresolved — only the amend path does", async () => {
    searchProductsMock = async () => ({ products: [] });
    const { ctx } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: { item: "xyzzy nonexistent" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect(ctx.amendItemUnresolved).toBeUndefined();
  });

  it("order.amend.update_qty resolves itemId (a REAL Medusa line-item id) from a UNIQUE matching line on the LIVE order", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: {
        items: [
          { id: "li_burger", title: "Hambúrguer", quantity: 1 },
          { id: "li_fries", title: "Batata", quantity: 1 },
        ],
      },
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.update_qty",
      payload: { orderId: "ord_1", item: "hambúrguer", quantity: 2 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { itemId?: string; quantity?: number };
    expect(p.itemId).toBe("li_burger");
    expect(p.quantity).toBe(2);
  });

  it("order.amend.remove_item resolves itemId the same way (no quantity field)", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: { items: [{ id: "li_burger", title: "Hambúrguer", quantity: 1 }] },
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.remove_item",
      payload: { orderId: "ord_1", item: "hambúrguer" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBe("li_burger");
  });

  it("leaves itemId UNSET when no line on the LIVE order matches the NL reference (not found — never guesses, downstream honestly refuses)", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: { items: [{ id: "li_burger", title: "Hambúrguer", quantity: 1 }] },
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.remove_item",
      payload: { orderId: "ord_1", item: "algo que não pedi" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBeUndefined();
  });

  // Review fix (post-#264): the FIRST cut reused ctx.autoResolvedMoneyRef
  // here (the ORDER-level "which order?" auto-resolve confirm mechanism),
  // but item-level ambiguity identifies NO item at all — routing it through
  // a yes/no confirm falsely implies a specific item was found, and
  // confirming resumed into a lookup with itemId undefined (a dead end:
  // "Item não encontrado" right after the customer said "yes"). Fixed:
  // itemId stays unset, autoResolvedMoneyRef is NEVER touched (no park, no
  // confirm), and itemAmbiguousCount is stamped instead so the executor
  // (register-ibatexas-tool-packs.ts's ambiguousItemReply) can surface an
  // honest, specific disambiguation reply — see that file's test for the
  // reply text itself.
  it("leaves itemId UNSET, does NOT touch ctx.autoResolvedMoneyRef, and stamps itemAmbiguousCount when two lines share a title (ambiguous — never guesses, never fakes a confirm)", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: {
        items: [
          { id: "li_burger_1", title: "Hambúrguer", quantity: 1 },
          { id: "li_burger_2", title: "Hambúrguer", quantity: 1 },
        ],
      },
    });
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.amend.update_qty",
      payload: { orderId: "ord_1", item: "hambúrguer", quantity: 2 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { itemId?: string; itemAmbiguousCount?: number };
    expect(p.itemId).toBeUndefined();
    expect(p.itemAmbiguousCount).toBe(2);
    expect((ctx as { autoResolvedMoneyRef?: boolean }).autoResolvedMoneyRef).toBeUndefined();
  });

  it("a THIRD same-titled line stamps itemAmbiguousCount: 3 (the count is real, not a fixed sentinel)", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: {
        items: [
          { id: "li_1", title: "Coca", quantity: 1 },
          { id: "li_2", title: "Coca", quantity: 1 },
          { id: "li_3", title: "Coca", quantity: 1 },
        ],
      },
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.remove_item",
      payload: { orderId: "ord_1", item: "coca" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemAmbiguousCount?: number }).itemAmbiguousCount).toBe(3);
  });

  it("does not smuggle a model-supplied itemAmbiguousCount through on a clean single match (always decided fresh)", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: { items: [{ id: "li_burger", title: "Hambúrguer", quantity: 1 }] },
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.update_qty",
      // An adversarial/malformed completion smuggling itemAmbiguousCount in
      // directly — a real UNIQUE match must still clear it, not preserve it.
      payload: { orderId: "ord_1", item: "hambúrguer", quantity: 2, itemAmbiguousCount: 99 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { itemId?: string; itemAmbiguousCount?: number };
    expect(p.itemId).toBe("li_burger");
    expect(p.itemAmbiguousCount).toBeUndefined();
  });

  it("leaves itemId UNSET when the order belongs to a different customer (ownership check fails — never a cross-customer leak)", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: false,
      order: { items: [{ id: "li_burger", title: "Hambúrguer", quantity: 1 }] },
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.remove_item",
      payload: { orderId: "ord_1", item: "hambúrguer" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBeUndefined();
  });

  it("swallows a live order-fetch error and leaves itemId unset (fail-closed, not a crash)", async () => {
    orderServiceGetOrder = async () => {
      throw new Error("medusa down");
    };
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.update_qty",
      payload: { orderId: "ord_1", item: "hambúrguer", quantity: 2 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBeUndefined();
  });

  it("does not override an explicit itemId", async () => {
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.update_qty",
      payload: { orderId: "ord_1", itemId: "explicit-item", quantity: 2 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBe("explicit-item");
  });
});

// ── Review B3 — order.item.add quantity coercion ─────────────────────────────
// The old `typeof quantity !== "number" → 1` silently rewrote the 4B's string
// emission ("2") to 1 — a customer asking for 2 items got 1. Positive-integer
// strings coerce; positive-integer numbers are kept; a MISSING quantity
// defaults to 1; a present-but-invalid value passes through untouched so the
// tool schema refuses loudly (never a silently different quantity).
describe("resolve-and-assemble — order.item.add quantity coercion (B3)", () => {
  async function quantityFor(raw: unknown): Promise<unknown> {
    const { payload } = await resolveAndAssemble({
      kind: "order.item.add",
      payload: {
        variantId: "var_explicit",
        allergens: [],
        ...(raw === undefined ? {} : { quantity: raw }),
      },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    return (payload as { quantity?: unknown }).quantity;
  }

  it('coerces a positive-integer string: "2" → 2', async () => {
    expect(await quantityFor("2")).toBe(2);
  });

  it('coerces a padded positive-integer string: " 4 " → 4', async () => {
    expect(await quantityFor(" 4 ")).toBe(4);
  });

  it("keeps a positive-integer number: 3 → 3", async () => {
    expect(await quantityFor(3)).toBe(3);
  });

  it("defaults a missing quantity to 1", async () => {
    expect(await quantityFor(undefined)).toBe(1);
  });

  // A PRESENT but invalid quantity is passed through untouched so
  // AddToCartInputSchema (z.number().int().min(1)) refuses LOUDLY and the
  // customer gets a clarify — a silent rewrite to 1 would put a quantity in
  // the cart the customer never asked for.
  it('passes junk string through for a loud refusal: "abc" stays "abc"', async () => {
    expect(await quantityFor("abc")).toBe("abc");
  });

  it("passes zero through for a loud refusal (never a silent 1)", async () => {
    expect(await quantityFor(0)).toBe(0);
    expect(await quantityFor("0")).toBe("0");
  });

  it("passes a negative quantity through for a loud refusal: -1 stays -1", async () => {
    expect(await quantityFor(-1)).toBe(-1);
  });

  it("passes a fractional quantity through for a loud refusal: 2.5 stays 2.5", async () => {
    expect(await quantityFor(2.5)).toBe(2.5);
  });
});

// BKL-038 — in-flight modify kinds share order.cancel's NL→id resolution
// (resolveOrderId → most-recent order) and forced confirm-on-autoresolve. Same
// list drives both the resolution assertions and the confirm-guard assertions.
//
// FE-T09 (D-a) — the granular amend kinds join this list: the model is never
// shown orderId (order-amend-granular.schema.ts forbids it), so a
// model-driven granular amend needs the SAME "most-recent order" auto-resolve
// order.amend.request already gets (ORDER_AUTORESOLVE_KINDS,
// AUTORESOLVE_CONFIRM_KINDS).
const INFLIGHT_MODIFY_KINDS = [
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
  "order.note.add",
  "order.address.change",
  "order.type.switch",
] as const;

describe("resolve-and-assemble — NL→id confirm-first (auto-resolve money intents)", () => {
  it("order.cancel with NO orderId auto-resolves the most-recent order + flags autoResolvedMoneyRef", async () => {
    orderListByCustomer = async () => ({
      orders: [{ id: "ord_recent", customerId: "c1" }],
      count: 1,
    });
    orderGetById = async () => ({ customerId: "c1", paymentStatus: "paid", totalInCentavos: 5000 });
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.cancel",
      payload: {},
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((payload as { orderId?: string }).orderId).toBe("ord_recent");
    expect(ctx.autoResolvedMoneyRef).toBe(true);
  });

  it("order.cancel with an EXPLICIT orderId does NOT auto-resolve (no confirm flag)", async () => {
    orderGetById = async () => ({ customerId: "c1", paymentStatus: "paid", totalInCentavos: 5000 });
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.cancel",
      payload: { orderId: "ord_explicit" },
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((payload as { orderId?: string }).orderId).toBe("ord_explicit");
    expect(ctx.autoResolvedMoneyRef).toBeUndefined();
  });

  it("order.cancel with NO orders → no auto-resolve, no flag (clean REFUSE downstream)", async () => {
    orderListByCustomer = async () => ({ orders: [], count: 0 });
    const { payload, ctx } = await resolveAndAssemble({
      kind: "order.cancel",
      payload: {},
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((payload as { orderId?: string }).orderId).toBeUndefined();
    expect(ctx.autoResolvedMoneyRef).toBeUndefined();
  });

  it("reservation.cancel auto-resolves ONLY when exactly one active booking exists", async () => {
    reservationListByCustomer = async () => ({
      reservations: [{ id: "res_1", status: "confirmed" }],
      total: 1,
    });
    const one = await resolveAndAssemble({
      kind: "reservation.cancel",
      payload: {},
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((one.payload as { reservationId?: string }).reservationId).toBe("res_1");
    expect(one.ctx.autoResolvedMoneyRef).toBe(true);

    // Ambiguous (2 active) → do NOT auto-resolve (agent clarifies).
    reservationListByCustomer = async () => ({
      reservations: [
        { id: "res_1", status: "confirmed" },
        { id: "res_2", status: "pending" },
      ],
      total: 2,
    });
    const two = await resolveAndAssemble({
      kind: "reservation.cancel",
      payload: {},
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((two.payload as { reservationId?: string }).reservationId).toBeUndefined();
    expect(two.ctx.autoResolvedMoneyRef).toBeUndefined();
  });

  // FE-T14 — reservation.modify joins RESERVATION_AUTORESOLVE_KINDS
  // (mirroring reservation.cancel's exact treatment): its extraction schema
  // never shows the model a reservationId field, and before this change
  // there was no auto-resolve path at all for this kind.
  it("reservation.modify auto-resolves ONLY when exactly one active booking exists", async () => {
    reservationListByCustomer = async () => ({
      reservations: [{ id: "res_1", status: "confirmed" }],
      total: 1,
    });
    const one = await resolveAndAssemble({
      kind: "reservation.modify",
      payload: { newPartySize: 6 },
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((one.payload as { reservationId?: string }).reservationId).toBe("res_1");
    expect((one.payload as { newPartySize?: number }).newPartySize).toBe(6);
    expect(one.ctx.autoResolvedMoneyRef).toBe(true);

    // Ambiguous (2 active) → do NOT auto-resolve (agent clarifies).
    reservationListByCustomer = async () => ({
      reservations: [
        { id: "res_1", status: "confirmed" },
        { id: "res_2", status: "pending" },
      ],
      total: 2,
    });
    const two = await resolveAndAssemble({
      kind: "reservation.modify",
      payload: { newPartySize: 6 },
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((two.payload as { reservationId?: string }).reservationId).toBeUndefined();
    expect(two.ctx.autoResolvedMoneyRef).toBeUndefined();
  });

  it("reservation.modify with an EXPLICIT reservationId does NOT auto-resolve (no confirm flag)", async () => {
    const { payload, ctx } = await resolveAndAssemble({
      kind: "reservation.modify",
      payload: { reservationId: "res_explicit", newPartySize: 6 },
      customerId: "c1",
      channel: "whatsapp",
    });
    expect((payload as { reservationId?: string }).reservationId).toBe("res_explicit");
    expect(ctx.autoResolvedMoneyRef).toBeUndefined();
  });

  // BKL-038 — the in-flight modify kinds resolve "meu pedido" exactly like
  // order.cancel: unambiguous single-order → most-recent order + confirm flag.
  it.each(INFLIGHT_MODIFY_KINDS)(
    "%s with NO orderId auto-resolves the most-recent order + flags autoResolvedMoneyRef",
    async (kind) => {
      orderListByCustomer = async () => ({
        orders: [{ id: "ord_recent", customerId: "c1" }],
        count: 1,
      });
      orderGetById = async () => ({ customerId: "c1", paymentStatus: "paid", totalInCentavos: 5000 });
      const { payload, ctx } = await resolveAndAssemble({
        kind,
        payload: {},
        customerId: "c1",
        channel: "whatsapp",
      });
      expect((payload as { orderId?: string }).orderId).toBe("ord_recent");
      expect(ctx.autoResolvedMoneyRef).toBe(true);
    },
  );

  it.each(INFLIGHT_MODIFY_KINDS)(
    "%s with an EXPLICIT orderId does NOT auto-resolve (no confirm flag)",
    async (kind) => {
      orderGetById = async () => ({ customerId: "c1", paymentStatus: "paid", totalInCentavos: 5000 });
      const { payload, ctx } = await resolveAndAssemble({
        kind,
        payload: { orderId: "ord_explicit" },
        customerId: "c1",
        channel: "whatsapp",
      });
      expect((payload as { orderId?: string }).orderId).toBe("ord_explicit");
      expect(ctx.autoResolvedMoneyRef).toBeUndefined();
    },
  );

  // (b) resolution failure keeps today's safe behavior: no order → no guessed
  // target, no flag → the pack REFUSEs cleanly downstream (never a silent guess).
  it.each(INFLIGHT_MODIFY_KINDS)(
    "%s with NO orders → no auto-resolve, no flag (clean REFUSE downstream)",
    async (kind) => {
      orderListByCustomer = async () => ({ orders: [], count: 0 });
      const { payload, ctx } = await resolveAndAssemble({
        kind,
        payload: {},
        customerId: "c1",
        channel: "whatsapp",
      });
      expect((payload as { orderId?: string }).orderId).toBeUndefined();
      expect(ctx.autoResolvedMoneyRef).toBeUndefined();
    },
  );
});

describe("confirm-on-autoresolve guard (mirrors claustrum-bootstrap)", () => {
  const guard = createConfirmGuard<string, unknown, unknown>({
    matches: (env) =>
      new Set([
        "order.cancel",
        "payment.pix.regenerate",
        "reservation.cancel",
        ...INFLIGHT_MODIFY_KINDS, // BKL-038 — mirrors AUTORESOLVE_CONFIRM_KINDS
      ]).has(env.kind),
    extract: (_env, state) =>
      (state as { ctx?: { autoResolvedMoneyRef?: boolean } }).ctx?.autoResolvedMoneyRef ? 1 : 0,
    threshold: 1,
    comparator: ">=",
    prompt: () => "confirma?",
  });
  const cancelEnv = buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "o1" },
    actor: { principal: "llm", sessionId: "s" },
    taint: "UNTRUSTED",
    nonce: "n",
  });

  it("REQUEST_CONFIRMATION when an ambiguous money ref was auto-resolved", () => {
    expect(guard(cancelEnv, { ctx: { autoResolvedMoneyRef: true } })?.kind).toBe(
      "REQUEST_CONFIRMATION",
    );
  });
  it("passes (null) when the id was explicit (no flag) — the resume case", () => {
    expect(guard(cancelEnv, { ctx: { autoResolvedMoneyRef: false } })).toBeNull();
    expect(guard(cancelEnv, { ctx: {} })).toBeNull();
  });
  it("does not fire for a kind outside the auto-resolve set", () => {
    // order.review.submit is an order-by-id kind but is NOT auto-resolved, so the
    // guard must never fire for it even if the flag were somehow present.
    const reviewEnv = buildEnvelope({
      kind: "order.review.submit",
      payload: {},
      actor: { principal: "llm", sessionId: "s" },
      taint: "UNTRUSTED",
      nonce: "n2",
    });
    expect(guard(reviewEnv, { ctx: { autoResolvedMoneyRef: true } })).toBeNull();
  });

  // BKL-038 — the in-flight modify kinds confirm their auto-resolved target just
  // like order.cancel (flag set → REQUEST_CONFIRMATION; resume/no-flag → passes).
  it.each(INFLIGHT_MODIFY_KINDS)(
    "REQUEST_CONFIRMATION for auto-resolved in-flight modify %s",
    (kind) => {
      const env = buildEnvelope({
        kind,
        payload: {},
        actor: { principal: "llm", sessionId: "s" },
        taint: "UNTRUSTED",
        nonce: `n-${kind}`,
      });
      expect(guard(env, { ctx: { autoResolvedMoneyRef: true } })?.kind).toBe(
        "REQUEST_CONFIRMATION",
      );
      expect(guard(env, { ctx: {} })).toBeNull(); // resume (explicit id, no flag)
    },
  );
});

describe("resolve-and-assemble — 034-F1 ownership binding (review findings 6/7/11)", () => {
  it("refund: binds ownership through the payment's order (paymentId → orderId), owner confirmed", async () => {
    // PaymentRefundIssuePayload carries ONLY paymentId — resolve its owning orderId.
    paymentGetById = async (id) => (id === "pay1" ? { id, orderId: "o1" } : null);
    orderGetById = async () => ({ customerId: "c1" });
    const { payload, owned, ownershipIndeterminate } = await resolveAndAssemble({
      kind: "payment.refund.issue",
      payload: { paymentId: "pay1", refundAmountCentavos: 1000 },
      customerId: "c1",
      channel: "web",
    });
    expect((payload as { orderId?: string }).orderId).toBe("o1"); // bound for the guard
    expect(owned).toEqual(["o1"]); // → authority graph engages, EXECUTE for the true owner
    expect(ownershipIndeterminate).toBe(false);
  });

  it("refund: a cross-principal payment yields owned=[] (guard REFUSEs), not indeterminate", async () => {
    paymentGetById = async () => ({ id: "pay1", orderId: "o1" });
    orderGetById = async () => ({ customerId: "SOMEONE-ELSE" }); // not c1's order
    const { payload, owned, ownershipIndeterminate } = await resolveAndAssemble({
      kind: "payment.refund.issue",
      payload: { paymentId: "pay1", refundAmountCentavos: 1000 },
      customerId: "c1",
      channel: "web",
    });
    expect((payload as { orderId?: string }).orderId).toBe("o1");
    expect(owned).toEqual([]); // confirmed-not-owned → REFUSE
    expect(ownershipIndeterminate).toBe(false);
  });

  it("transient DB error → ownershipIndeterminate=true (guard stays inert, no false REFUSE of the true owner)", async () => {
    orderGetById = async () => {
      throw new Error("db timeout");
    };
    const { owned, ownershipIndeterminate } = await resolveAndAssemble({
      kind: "order.cancel",
      payload: { orderId: "o1" },
      customerId: "c1",
      channel: "web",
    });
    expect(owned).toEqual([]);
    expect(ownershipIndeterminate).toBe(true); // ← distinct from confirmed-not-owned
  });

  it("confirmed-not-owned (customer mismatch) is NOT indeterminate (so the guard REFUSEs)", async () => {
    orderGetById = async () => ({ customerId: "SOMEONE-ELSE" });
    const { owned, ownershipIndeterminate } = await resolveAndAssemble({
      kind: "order.cancel",
      payload: { orderId: "o1" },
      customerId: "c1",
      channel: "web",
    });
    expect(owned).toEqual([]);
    expect(ownershipIndeterminate).toBe(false);
  });
});

describe("resolve-and-assemble — D1 refund freshness/refundable ctx (Inv 11 strengthen)", () => {
  it("stamps paymentReadThisTurn + currentStatus on a LIVE active-payment read (feeds the pack's refundable + freshness conjuncts)", async () => {
    paymentGetById = async (id) => (id === "pay1" ? { id, orderId: "o1" } : null);
    orderGetById = async () => ({ customerId: "c1" });
    paymentGetActiveByOrderId = async () => ({
      status: "paid",
      method: "pix",
      amountInCentavos: 30_000,
      refundedAmountCentavos: 0,
      version: 1,
    });
    const { ctx, owned } = await resolveAndAssemble({
      kind: "payment.refund.issue",
      payload: { paymentId: "pay1", refundAmountCentavos: 1000 },
      customerId: "c1",
      channel: "web",
    });
    // must_read_this_turn marker (SDD §5 fresh / §G sourceMode==live).
    expect(ctx.paymentReadThisTurn).toBe(true);
    expect(ctx.currentStatus).toBe("paid"); // refundable-state conjunct sees a settled payment
    expect(ctx.exists).toBe(true);
    expect(owned).toEqual(["o1"]); // ownership conjunct: authority graph engages
  });

  it("does NOT stamp paymentReadThisTurn when the owned order has NO active payment (nothing read live → fails closed at the pack)", async () => {
    paymentGetById = async (id) => (id === "pay1" ? { id, orderId: "o1" } : null);
    orderGetById = async () => ({ customerId: "c1" });
    paymentGetActiveByOrderId = async () => null; // owned, but no active payment
    const { ctx } = await resolveAndAssemble({
      kind: "payment.refund.issue",
      payload: { paymentId: "pay1", refundAmountCentavos: 1000 },
      customerId: "c1",
      channel: "web",
    });
    expect(ctx.exists).toBe(false);
    expect(ctx.paymentReadThisTurn).toBeUndefined();
  });
});

describe("resolve-and-assemble — identity base", () => {
  it("marks a guest unauthenticated and never sets customerId", async () => {
    const { ctx } = await resolveAndAssemble({
      kind: "order.cart.ensure",
      payload: {},
      customerId: "guest:abc",
      channel: "web",
    });
    expect(ctx.isAuthenticated).toBe(false);
    expect(ctx.customerId).toBeNull();
    expect(ctx.tenantId).toBe("ibatexas");
    expect(ctx.sessionTokensConsumed).toBe(0);
  });
});

describe("resolve-and-assemble — agent-namespace token read (T3-4)", () => {
  const AGENT_NS = "agent:pix-payment-failure-remediation@0.1.0";
  const AGENT_SESSION = `${AGENT_NS}:entity:pay_001`;

  it("injects ctx.agentTokensConsumed for agent sessions, keyed by the agent namespace via sessionTokenKey", async () => {
    const seen: string[] = [];
    redisGet = async (k) => {
      seen.push(k);
      if (k === sessionTokenKey("system", AGENT_NS)) return "150000";
      if (k === sessionTokenKey("system", "cust_001")) return "777";
      return null;
    };
    const { ctx } = await resolveAndAssemble({
      kind: "payment.pix.regenerate",
      payload: { orderId: "o1" },
      customerId: "cust_001",
      channel: "system",
      sessionId: AGENT_SESSION,
    });
    // Agent meter read off the NAMESPACE (id@version), never the full
    // per-entity sessionId — tokensPerDay aggregates across entity capsules.
    expect(ctx.agentTokensConsumed).toBe(150_000);
    expect(seen).toContain(sessionTokenKey("system", AGENT_NS));
    expect(seen).not.toContain(sessionTokenKey("system", AGENT_SESSION));
    // The F4 customer-session read is unchanged and coexists.
    expect(ctx.sessionTokensConsumed).toBe(777);
  });

  it("non-agent sessions get NO agent meter (key never read, ctx key absent)", async () => {
    const seen: string[] = [];
    redisGet = async (k) => {
      seen.push(k);
      return null;
    };
    const { ctx } = await resolveAndAssemble({
      kind: "order.note.add",
      payload: { orderId: "o1" },
      customerId: "c1",
      channel: "web",
      sessionId: "chat-session-123",
    });
    expect(ctx.agentTokensConsumed).toBeUndefined();
    expect(seen).toEqual([sessionTokenKey("web", "c1")]);
  });

  it("fails OPEN to 0 on a meter read error (parity with the F4 read side)", async () => {
    redisGet = async (k) => {
      if (k === sessionTokenKey("system", AGENT_NS)) throw new Error("redis down");
      return null;
    };
    const { ctx } = await resolveAndAssemble({
      kind: "payment.pix.regenerate",
      payload: { orderId: "o1" },
      customerId: "cust_001",
      channel: "system",
      sessionId: AGENT_SESSION,
    });
    expect(ctx.agentTokensConsumed).toBe(0);
  });
});

// resolveCustomerOrderReference: the customer-plane read executors'
// (check_order_status/get_payment_status) reference-resolution helper.
//   FE-T13 — an explicit display-number reference wins (IDOR-checked).
//   BKL-140 — the id-less path is ACTIVE-order-aware: one active order → resolve;
//             ≥2 active → ambiguous (disambiguate, never guess); 0 active but orders
//             exist → most-recent (honest); no orders → null.
//   FE-D24 — a relative-date reference filters the caller's OWN orders by day.
// Active fulfillment stages: pending/confirmed/preparing/ready/in_delivery.
const ACTIVE = "preparing"; // an active (non-terminal) fulfillment stage
const TERMINAL = "delivered"; // a terminal stage (never "active")
function ord(
  id: string,
  displayId: number,
  fulfillmentStatus: string,
  medusaCreatedAt = new Date("2026-07-10T12:00:00Z"),
) {
  return { id, displayId, fulfillmentStatus, medusaCreatedAt };
}

describe("resolveCustomerOrderReference — displayId reference (FE-T13)", () => {
  it("a display-number reference matching an OWNED order → resolves it, IDOR-checked", async () => {
    let calls = 0;
    orderFindByDisplayId = async () => {
      calls++;
      return [
        { id: "ord_other_customer", customerId: "someone-else" },
        { id: "ord_1234", customerId: "c1" },
      ];
    };
    orderListByCustomer = async () => ({ orders: [ord("ord_recent", 9, ACTIVE)], count: 1 });
    const result = await resolveCustomerOrderReference("1234", "c1");
    expect(result).toMatchObject({ orderId: "ord_1234", referenceMatched: true, ambiguous: false });
    expect(calls).toBe(1);
  });

  it("a display-number matching ONLY another customer's order → IDOR-safe fallback, NEVER the foreign order", async () => {
    orderFindByDisplayId = async () => [{ id: "ord_foreign", customerId: "victim" }];
    orderListByCustomer = async () => ({ orders: [ord("ord_recent", 9, ACTIVE)], count: 1 });
    const result = await resolveCustomerOrderReference("1234", "c1");
    expect(result.orderId).toBe("ord_recent");
    expect(result.referenceMatched).toBe(false);
  });

  it("a #-prefixed display-number parses the same as a bare number", async () => {
    orderFindByDisplayId = async () => [{ id: "ord_1234", customerId: "c1" }];
    const result = await resolveCustomerOrderReference("#1234", "c1");
    expect(result).toMatchObject({ orderId: "ord_1234", referenceMatched: true });
  });

  it("a displayId lookup that throws degrades to the id-less fallback (fail-safe)", async () => {
    orderFindByDisplayId = async () => {
      throw new Error("db down");
    };
    orderListByCustomer = async () => ({ orders: [ord("ord_recent", 9, ACTIVE)], count: 1 });
    const result = await resolveCustomerOrderReference("1234", "c1");
    expect(result.orderId).toBe("ord_recent");
  });
});

describe("resolveCustomerOrderReference — BKL-140 id-less active-order resolution", () => {
  it("exactly ONE active order → resolves it (autoResolved)", async () => {
    orderListByCustomer = async () => ({
      orders: [ord("ord_active", 10, ACTIVE), ord("ord_old", 8, TERMINAL)],
      count: 2,
    });
    const result = await resolveCustomerOrderReference(undefined, "c1");
    expect(result).toMatchObject({
      orderId: "ord_active",
      autoResolved: true,
      ambiguous: false,
      referenceMatched: false,
    });
  });

  it("TWO active orders → ambiguous, no orderId, candidates carry the display numbers", async () => {
    orderListByCustomer = async () => ({
      orders: [ord("ord_a", 11, ACTIVE), ord("ord_b", 12, ACTIVE), ord("ord_old", 5, TERMINAL)],
      count: 3,
    });
    const result = await resolveCustomerOrderReference(undefined, "c1");
    expect(result.orderId).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toEqual([
      { orderId: "ord_a", displayId: 11 },
      { orderId: "ord_b", displayId: 12 },
    ]);
  });

  it("ZERO orders → honest no-order result (orderId null, NOT ambiguous)", async () => {
    orderListByCustomer = async () => ({ orders: [], count: 0 });
    const result = await resolveCustomerOrderReference(undefined, "c1");
    expect(result).toMatchObject({ orderId: null, ambiguous: false, autoResolved: false });
  });

  it("orders exist but NONE active → most-recent fallback (honest 'your last order …')", async () => {
    orderListByCustomer = async () => ({
      orders: [ord("ord_last", 20, TERMINAL), ord("ord_older", 19, "canceled")],
      count: 2,
    });
    const result = await resolveCustomerOrderReference(undefined, "c1");
    expect(result).toMatchObject({ orderId: "ord_last", autoResolved: true, ambiguous: false });
  });

  it("a reference that is neither a display number nor a date → id-less resolution", async () => {
    orderListByCustomer = async () => ({ orders: [ord("ord_active", 10, ACTIVE)], count: 1 });
    const result = await resolveCustomerOrderReference("meu pedido", "c1");
    expect(result).toMatchObject({ orderId: "ord_active", autoResolved: true });
  });
});

describe("resolveCustomerOrderReference — FE-D24 relative-date reference", () => {
  // Tie the order dates to the resolver's OWN date computation so the arm is
  // deterministic regardless of the run date (noon-UTC on the target day is the
  // same restaurant-TZ calendar day, UTC-3).
  const yesterday = parseRelativeOrderDate("de ontem")!;
  const onYesterday = (id: string, displayId: number) =>
    ord(id, displayId, ACTIVE, new Date(`${yesterday}T12:00:00Z`));

  it("'de ontem' matching exactly ONE order that day → resolves it (referenceMatched)", async () => {
    orderListByCustomer = async () => ({
      orders: [onYesterday("ord_yst", 30), ord("ord_today", 31, ACTIVE, new Date())],
      count: 2,
    });
    const result = await resolveCustomerOrderReference("o pedido de ontem", "c1");
    expect(result).toMatchObject({ orderId: "ord_yst", referenceMatched: true, ambiguous: false });
  });

  it("'de ontem' matching TWO orders that day → ambiguous with candidates", async () => {
    orderListByCustomer = async () => ({
      orders: [onYesterday("ord_y1", 40), onYesterday("ord_y2", 41)],
      count: 2,
    });
    const result = await resolveCustomerOrderReference("de ontem", "c1");
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.map((c) => c.orderId)).toEqual(["ord_y1", "ord_y2"]);
  });

  it("'de ontem' matching NO order that day → falls through to id-less resolution", async () => {
    orderListByCustomer = async () => ({ orders: [ord("ord_active", 50, ACTIVE, new Date())], count: 1 });
    const result = await resolveCustomerOrderReference("de ontem", "c1");
    // 0 orders yesterday → id-less: the one active (today) order resolves.
    expect(result).toMatchObject({ orderId: "ord_active", autoResolved: true, referenceMatched: false });
  });
});

describe("parseRelativeOrderDate — FE-D24 deterministic pt-BR past-date parser", () => {
  const today = parseRelativeOrderDate("hoje")!;
  const shift = (ymd: string, delta: number) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };

  it("'hoje' → today; 'ontem' → today-1; 'anteontem' → today-2", () => {
    expect(parseRelativeOrderDate("hoje")).toBe(today);
    expect(parseRelativeOrderDate("o pedido de ontem")).toBe(shift(today, -1));
    expect(parseRelativeOrderDate("anteontem")).toBe(shift(today, -2));
  });

  it("a named weekday → its most-recent occurrence on-or-before today (offset 0..6)", () => {
    const target = parseRelativeOrderDate("de terça")!;
    const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
    const targetDow = new Date(`${target}T00:00:00Z`).getUTCDay();
    expect(targetDow).toBe(2); // terça = Tuesday
    // never in the future
    expect(target <= today).toBe(true);
    expect(shift(today, -((todayDow - 2 + 7) % 7))).toBe(target);
  });

  it("no recognized date marker → null (a bare display number is NOT a date)", () => {
    expect(parseRelativeOrderDate("1234")).toBeNull();
    expect(parseRelativeOrderDate("meu pedido")).toBeNull();
  });
});

// ── FE-T14 — customer.preferences.update: allergenExclusions preservation
//    + the allergen-mention honesty detector ────────────────────────────────

describe("isAllergenMentionUtterance — FE-T14 pure detector", () => {
  it.each([
    "sou alérgico a amendoim, atualiza aí",
    "tenho alergia a lactose",
    "minha filha é alérgica a glúten",
    "cuidado, alergênico",
    "ele teve uma reação anafilática",
  ])("detects an allergen-shaped utterance: %s", (text) => {
    expect(isAllergenMentionUtterance(text)).toBe(true);
  });

  it.each([
    "sou vegetariano e adoro comida grelhada",
    "quero atualizar minhas preferências",
    "",
    undefined,
  ])("does NOT flag an ordinary preferences utterance: %s", (text) => {
    expect(isAllergenMentionUtterance(text)).toBe(false);
  });
});

describe("resolveAndAssemble — customer.preferences.update (FE-T14)", () => {
  it("allergenExclusions is ALWAYS resolver-stamped from the customer's current saved value, never from the model", async () => {
    customerGetProfileData = async () => ({
      customerPrefs: { allergenExclusions: ["amendoim"] },
    });
    const { payload } = await resolveAndAssemble({
      kind: "customer.preferences.update",
      // Adversarial: the model smuggled its own allergenExclusions guess —
      // it must be UNCONDITIONALLY discarded, never survive to the payload.
      payload: { dietaryFlags: ["vegetariano"], allergenExclusions: ["smuggled"] },
      customerId: "c1",
      channel: "web",
    });
    expect((payload as { allergenExclusions?: string[] }).allergenExclusions).toEqual(["amendoim"]);
    expect((payload as { dietaryFlags?: string[] }).dietaryFlags).toEqual(["vegetariano"]);
  });

  it("a customer with no saved preferences row defaults to allergenExclusions: [] (never REFUSEs a new customer)", async () => {
    customerGetProfileData = async () => ({ customerPrefs: null });
    const { payload } = await resolveAndAssemble({
      kind: "customer.preferences.update",
      payload: { favoriteCategories: ["churrasco"] },
      customerId: "c1",
      channel: "web",
    });
    expect((payload as { allergenExclusions?: string[] }).allergenExclusions).toEqual([]);
  });

  it("a transient read error fails CLOSED to allergenExclusions: [] rather than leaving the field unresolved", async () => {
    customerGetProfileData = async () => {
      throw new Error("db down");
    };
    const { payload } = await resolveAndAssemble({
      kind: "customer.preferences.update",
      payload: { dietaryFlags: ["vegano"] },
      customerId: "c1",
      channel: "web",
    });
    expect((payload as { allergenExclusions?: string[] }).allergenExclusions).toEqual([]);
  });

  it("an allergen-shaped utterance stamps ctx.allergenMentionDetected — refuseAllergenMentionGuard reads this to REFUSE honestly", async () => {
    const { ctx } = await resolveAndAssemble({
      kind: "customer.preferences.update",
      payload: {},
      customerId: "c1",
      channel: "web",
      utteranceText: "sou alérgico a amendoim, atualiza aí",
    });
    expect(ctx.allergenMentionDetected).toBe(true);
  });

  it("an ordinary preferences utterance does NOT stamp ctx.allergenMentionDetected", async () => {
    const { ctx } = await resolveAndAssemble({
      kind: "customer.preferences.update",
      payload: { dietaryFlags: ["vegetariano"] },
      customerId: "c1",
      channel: "web",
      utteranceText: "sou vegetariano e adoro comida grelhada",
    });
    expect(ctx.allergenMentionDetected).toBeUndefined();
  });

  it("an absent utteranceText (e.g. an HTTP caller with no conductor cognition) never trips the detector", async () => {
    const { ctx } = await resolveAndAssemble({
      kind: "customer.preferences.update",
      payload: {},
      customerId: "c1",
      channel: "web",
    });
    expect(ctx.allergenMentionDetected).toBeUndefined();
  });

  it("the allergen-mention detector is INERT for every other kind, even with allergen-shaped text", async () => {
    const { ctx } = await resolveAndAssemble({
      kind: "order.note.add",
      payload: { orderId: "o1", body: "sou alérgico a amendoim" },
      customerId: "c1",
      channel: "web",
      utteranceText: "sou alérgico a amendoim",
    });
    expect(ctx.allergenMentionDetected).toBeUndefined();
  });
});

// ── team-lead ruling — the variantId bridge (FE-T14 live-calibration finding) ─
//
// LIVE-CAUGHT: `resolveCartLineItem`/`resolveOrderLineItem`'s original
// exact-title-only match compared the model's NL reference ("coca") against
// each line's `.title`, which Medusa always sets to the PRODUCT title
// ("Refrigerante") — never the variant title ("Coca-Cola") a casual
// reference actually names. Every item.update/item.remove/amend.update_qty/
// amend.remove_item case naming a variant this way resolved `not_found`
// against the REAL catalog regardless of seeding (first live calibration
// this resolver family ever had). Fix: `resolveLineItemByNameOrVariant`
// (resolve-and-assemble.ts) tries exact-title first (fast path, no network),
// then bridges through the SAME `resolveProductForItem`/`hasLexicalOverlap`
// floor `order.item.add`/`order.amend.add_item` already use, matching lines
// by the resolved `variant_id`. `resolveCartLineItem` (cart, order.item.*)
// and `resolveOrderLineItem` (placed order, order.amend.*) share this ONE
// core (FE-D07) — every arm below is asserted through BOTH capability
// families driving the SAME shared function, never re-tested per resolver.
describe("resolve-and-assemble — the variantId bridge (order.item.update/remove + order.amend.update_qty/remove_item)", () => {
  it("[cart] variant-title match: exact-title finds nothing (line title is the PRODUCT name), the bridge resolves by variant_id", async () => {
    redisGet = async (k) => (k === "cart:active:session:conv-1" ? "cart_abc" : null);
    medusaStoreFetch = async () => ({
      cart: {
        items: [{ id: "cali_coke", title: "Refrigerante", variant_id: "var_coke" }],
        total: 8,
        completed_at: null,
      },
    });
    searchProductsMock = async () => ({
      products: [
        { id: "prod_1", title: "Refrigerante", tags: ["coca", "coca-cola"], variants: [{ id: "var_coke" }] },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.update",
      payload: { item: "coca", quantity: 3 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBe("cali_coke");
  });

  it("[order] variant-title match: same bridge resolves an EXISTING placed-order line by variant_id", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: { items: [{ id: "li_coke", title: "Refrigerante", variant_id: "var_coke" }] },
    });
    searchProductsMock = async () => ({
      products: [
        { id: "prod_1", title: "Refrigerante", tags: ["coca", "coca-cola"], variants: [{ id: "var_coke" }] },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.remove_item",
      payload: { orderId: "ord_1", item: "coca" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBe("li_coke");
  });

  it("[cart] product-title fallback: a literal, unambiguous title reference resolves via arm 1 WITHOUT ever calling the search bridge (no round-trip)", async () => {
    redisGet = async () => "cart_abc";
    let searchCalled = false;
    medusaStoreFetch = async () => ({
      cart: {
        items: [{ id: "cali_soda", title: "Refrigerante", variant_id: "var_coke" }],
        total: 8,
        completed_at: null,
      },
    });
    searchProductsMock = async () => {
      searchCalled = true;
      return { products: [] };
    };
    const { payload } = await resolveAndAssemble({
      kind: "order.item.remove",
      payload: { item: "Refrigerante" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBe("cali_soda");
    expect(searchCalled).toBe(false);
  });

  it("[cart] ambiguous-across-lines: the bridge resolves a variant that matches TWO lines (the customer added \"coca\" twice) — ambiguous, never a guess", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({
      cart: {
        items: [
          { id: "cali_coke_1", title: "Refrigerante", variant_id: "var_coke" },
          { id: "cali_coke_2", title: "Refrigerante", variant_id: "var_coke" },
        ],
        total: 16,
        completed_at: null,
      },
    });
    searchProductsMock = async () => ({
      products: [
        { id: "prod_1", title: "Refrigerante", tags: ["coca", "coca-cola"], variants: [{ id: "var_coke" }] },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.remove",
      payload: { item: "coca" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    const p = payload as { itemId?: string; itemAmbiguousCount?: number };
    expect(p.itemId).toBeUndefined();
    expect(p.itemAmbiguousCount).toBe(2);
  });

  it("[order] ambiguous-across-lines: an exact-title tie the bridge CANNOT disambiguate (no catalog match) falls back to the original exact-title ambiguous count", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: {
        items: [
          { id: "li_1", title: "Hambúrguer", variant_id: "var_burger" },
          { id: "li_2", title: "Hambúrguer", variant_id: "var_burger" },
        ],
      },
    });
    searchProductsMock = async () => ({ products: [] });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.update_qty",
      payload: { orderId: "ord_1", item: "hambúrguer", quantity: 2 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemAmbiguousCount?: number }).itemAmbiguousCount).toBe(2);
  });

  it("[cart] not-found: neither exact-title nor the bridge resolves anything — never a guess", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({
      cart: { items: [{ id: "cali_burger", title: "Smash Burger", variant_id: "var_burger" }], total: 30, completed_at: null },
    });
    searchProductsMock = async () => ({ products: [] });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.update",
      payload: { item: "sobremesa que não pedi", quantity: 1 },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBeUndefined();
  });

  it("[order] floor-rejection: the bridge's top hit shares NO lexical relationship with the query — hasLexicalOverlap rejects it, treated exactly like no match", async () => {
    orderServiceGetOrder = async () => ({
      ownershipValid: true,
      order: { items: [{ id: "li_1", title: "Refrigerante", variant_id: "var_coke" }] },
    });
    // Live-caught arbitrary-match defect's floor (FE-D17 interim, hasLexicalOverlap):
    // an UNRELATED top hit (zero shared tokens/substrings with the query)
    // must not be trusted — same posture as order.item.add's own coverage.
    searchProductsMock = async () => ({
      products: [{ id: "prod_9", title: "Kit Presente IbateXas", variants: [{ id: "var_gift" }] }],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.amend.remove_item",
      payload: { orderId: "ord_1", item: "xyzzy nonexistent" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBeUndefined();
  });

  it("[cart] the bridge is a genuine BROADENING: a reference that was `not_found` before this fix now resolves (prior-`not_found` -> `found`)", async () => {
    redisGet = async () => "cart_abc";
    medusaStoreFetch = async () => ({
      cart: {
        items: [{ id: "cali_guarana", title: "Refrigerante", variant_id: "var_guarana" }],
        total: 8,
        completed_at: null,
      },
    });
    searchProductsMock = async () => ({
      products: [
        {
          id: "prod_1",
          title: "Refrigerante",
          tags: ["guaraná", "guarana antarctica"],
          variants: [{ id: "var_guarana" }],
        },
      ],
    });
    const { payload } = await resolveAndAssemble({
      kind: "order.item.remove",
      // Pre-fix: exact-title("guaraná") vs the line's title("Refrigerante")
      // never matched — always not_found. Post-fix: the bridge resolves it.
      payload: { item: "guaraná" },
      customerId: "c1",
      channel: "web",
      sessionId: "conv-1",
    });
    expect((payload as { itemId?: string }).itemId).toBe("cali_guarana");
  });
});

// FE-D27 — NL slot-booking: date/time → a REAL timeSlotId via the SAME
// checkAvailability lookup, with honest no-availability + CLARIFY-on-ambiguity.
describe("resolveReservationSlot — FE-D27 NL date/time → timeSlotId", () => {
  const CUSTOMER = "c1";

  it("create: exactly ONE available slot → stamps the real timeSlotId", async () => {
    reservationCheckAvailability = async (date, partySize) => {
      expect(date).toBe("2026-03-20");
      expect(partySize).toBe(4);
      return [{ timeSlotId: "slot_real_1" }];
    };
    const out = await resolveReservationSlot(
      "reservation.create",
      { date: "2026-03-20", time: "20:00", partySize: 4 },
      CUSTOMER,
    );
    expect(out.timeSlotId).toBe("slot_real_1");
    expect(out.slotAmbiguousCount).toBeUndefined();
  });

  it("create: ZERO slots → payload unchanged (no timeSlotId → honest no-availability refuse)", async () => {
    reservationCheckAvailability = async () => [];
    const out = await resolveReservationSlot(
      "reservation.create",
      { date: "2026-03-20", partySize: 4 },
      CUSTOMER,
    );
    expect(out.timeSlotId).toBeUndefined();
    expect(out.slotAmbiguousCount).toBeUndefined();
  });

  it("create: ≥2 slots → slotAmbiguousCount + first-party candidate times, slot UNSTAMPED (CLARIFY)", async () => {
    reservationCheckAvailability = async () => [
      { timeSlotId: "a", startTime: "18:30" },
      { timeSlotId: "b", startTime: "20:00" },
      { timeSlotId: "c", startTime: "21:30" },
    ];
    const out = await resolveReservationSlot(
      "reservation.create",
      { date: "2026-03-20", partySize: 4 },
      CUSTOMER,
    );
    expect(out.timeSlotId).toBeUndefined();
    expect(out.slotAmbiguousCount).toBe(3);
    // BKL-174 — the availability read's own `startTime`s ride along so the pack
    // CLARIFY guard can NAME the options (first-party, never model-authored).
    expect(out.slotAmbiguousTimes).toEqual(["18:30", "20:00", "21:30"]);
  });

  it("create: an already-chosen timeSlotId is NEVER overridden (the listed-slot path)", async () => {
    let called = false;
    reservationCheckAvailability = async () => {
      called = true;
      return [{ timeSlotId: "other" }];
    };
    const out = await resolveReservationSlot(
      "reservation.create",
      { timeSlotId: "slot_listed", date: "2026-03-20", partySize: 4 },
      CUSTOMER,
    );
    expect(out.timeSlotId).toBe("slot_listed");
    expect(called).toBe(false);
  });

  it("create: a non-ISO date is never queried → payload unchanged (FE-D24's backward parser is deliberately not reused)", async () => {
    let called = false;
    reservationCheckAvailability = async () => {
      called = true;
      return [{ timeSlotId: "x" }];
    };
    const out = await resolveReservationSlot(
      "reservation.create",
      { date: "sexta", partySize: 4 },
      CUSTOMER,
    );
    expect(out.timeSlotId).toBeUndefined();
    expect(called).toBe(false);
  });

  it("create: an absent partySize is never queried (nothing to size availability against)", async () => {
    let called = false;
    reservationCheckAvailability = async () => {
      called = true;
      return [{ timeSlotId: "x" }];
    };
    const out = await resolveReservationSlot("reservation.create", { date: "2026-03-20" }, CUSTOMER);
    expect(out.timeSlotId).toBeUndefined();
    expect(called).toBe(false);
  });

  it("create: the optional time threads through to the availability filter", async () => {
    let seenTime: string | undefined;
    reservationCheckAvailability = async (_d, _p, time) => {
      seenTime = time;
      return [{ timeSlotId: "s" }];
    };
    await resolveReservationSlot(
      "reservation.create",
      { date: "2026-03-20", time: "20:00", partySize: 2 },
      CUSTOMER,
    );
    expect(seenTime).toBe("20:00");
  });

  it("create: a lookup error is fail-safe → payload unchanged (never throws)", async () => {
    reservationCheckAvailability = async () => {
      throw new Error("db down");
    };
    const out = await resolveReservationSlot(
      "reservation.create",
      { date: "2026-03-20", partySize: 4 },
      CUSTOMER,
    );
    expect(out.timeSlotId).toBeUndefined();
  });

  it("waitlist.join: same grounding as create (exactly-one → timeSlotId)", async () => {
    reservationCheckAvailability = async () => [{ timeSlotId: "wl_slot" }];
    const out = await resolveReservationSlot(
      "reservation.waitlist.join",
      { date: "2026-03-20", partySize: 2 },
      CUSTOMER,
    );
    expect(out.timeSlotId).toBe("wl_slot");
  });

  it("modify: newDate+newPartySize → newTimeSlotId (not timeSlotId)", async () => {
    reservationCheckAvailability = async (_d, partySize) => {
      expect(partySize).toBe(6);
      return [{ timeSlotId: "new_slot" }];
    };
    const out = await resolveReservationSlot(
      "reservation.modify",
      { reservationId: "r1", newDate: "2026-03-20", newPartySize: 6 },
      CUSTOMER,
    );
    expect(out.newTimeSlotId).toBe("new_slot");
    expect(out.timeSlotId).toBeUndefined();
  });

  it("modify: a time-only change sizes against the reservation's OWN partySize", async () => {
    reservationGetById = async (id) =>
      id === "r1" ? { id: "r1", partySize: 3, status: "confirmed", timeSlot: { id: "old" } } : null;
    let seenSize: number | undefined;
    reservationCheckAvailability = async (_d, partySize) => {
      seenSize = partySize;
      return [{ timeSlotId: "new_slot" }];
    };
    const out = await resolveReservationSlot(
      "reservation.modify",
      { reservationId: "r1", newDate: "2026-03-20", newTime: "20:00" },
      CUSTOMER,
    );
    expect(seenSize).toBe(3);
    expect(out.newTimeSlotId).toBe("new_slot");
  });

  it("a non-reservation kind is a no-op (same reference back)", async () => {
    const payload = { date: "2026-03-20", partySize: 4 };
    const out = await resolveReservationSlot("order.checkout.create", payload, CUSTOMER);
    expect(out).toBe(payload);
  });
});
