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
let reservationGetById: (id: string, customerId: string) => Promise<unknown> = async () => {
  throw new Error("not found");
};
let timeSlotFindUnique: (args: unknown) => Promise<unknown> = async () => null;
let medusaStoreFetch: (path: string) => Promise<unknown> = async () => ({});
let orderListByCustomer: (cid: string, input?: unknown) => Promise<{ orders: unknown[]; count: number }> =
  async () => ({ orders: [], count: 0 });
let reservationListByCustomer: (cid: string, opts?: unknown) => Promise<{ reservations: unknown[]; total: number }> =
  async () => ({ reservations: [], total: 0 });

vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => s,
  getRedisClient: async () => ({ get: (k: string) => redisGet(k) }),
  medusaStore: (path: string) => medusaStoreFetch(path),
  reaisToCentavos: (reais: number) => Math.round(reais * 100),
}));
vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: (id: string) => orderGetById(id),
    listByCustomer: (cid: string, input?: unknown) => orderListByCustomer(cid, input),
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: async () => null,
    listByOrderId: async () => ({ payments: [], count: 0 }),
  }),
  createCustomerService: () => ({ getById: async () => null }),
  createReservationService: () => ({
    getById: (id: string, customerId: string) => reservationGetById(id, customerId),
    listByCustomer: (cid: string, opts?: unknown) => reservationListByCustomer(cid, opts),
  }),
  prisma: { timeSlot: { findUnique: (args: unknown) => timeSlotFindUnique(args) } },
}));

// Import AFTER mocks (vitest hoists vi.mock).
const { resolveAndAssemble, sessionTokenKey } = await import("../resolve-and-assemble.js");

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
  reservationGetById = async () => {
    throw new Error("not found");
  };
  timeSlotFindUnique = async () => null;
  medusaStoreFetch = async () => ({});
  orderListByCustomer = async () => ({ orders: [], count: 0 });
  reservationListByCustomer = async () => ({ reservations: [], total: 0 });
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
});

describe("confirm-on-autoresolve guard (mirrors claustrum-bootstrap)", () => {
  const guard = createConfirmGuard<string, unknown, unknown>({
    matches: (env) =>
      new Set(["order.cancel", "payment.pix.regenerate", "reservation.cancel"]).has(env.kind),
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
  it("does not fire for non-money kinds", () => {
    const noteEnv = buildEnvelope({
      kind: "order.note.add",
      payload: {},
      actor: { principal: "llm", sessionId: "s" },
      taint: "UNTRUSTED",
      nonce: "n2",
    });
    expect(guard(noteEnv, { ctx: { autoResolvedMoneyRef: true } })).toBeNull();
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
