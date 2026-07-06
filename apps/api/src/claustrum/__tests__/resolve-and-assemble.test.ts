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
let timeSlotFindUnique: (args: unknown) => Promise<unknown> = async () => null;
let medusaStoreFetch: (path: string) => Promise<unknown> = async () => ({});
let searchProductsMock: (input: unknown, ctx?: unknown) => Promise<unknown> = async () => ({ products: [] });
let orderListByCustomer: (cid: string, input?: unknown) => Promise<{ orders: unknown[]; count: number }> =
  async () => ({ orders: [], count: 0 });
let reservationListByCustomer: (cid: string, opts?: unknown) => Promise<{ reservations: unknown[]; total: number }> =
  async () => ({ reservations: [], total: 0 });

vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => s,
  getRedisClient: async () => ({ get: (k: string) => redisGet(k) }),
  medusaStore: (path: string) => medusaStoreFetch(path),
  reaisToCentavos: (reais: number) => Math.round(reais * 100),
  searchProducts: (input: unknown, ctx?: unknown) => searchProductsMock(input, ctx),
}));
vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: (id: string) => orderGetById(id),
    listByCustomer: (cid: string, input?: unknown) => orderListByCustomer(cid, input),
  }),
  createPaymentQueryService: () => ({
    getById: (id: string) => paymentGetById(id),
    getActiveByOrderId: (orderId: string) => paymentGetActiveByOrderId(orderId),
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
  paymentGetById = async () => null;
  paymentGetActiveByOrderId = async () => null;
  reservationGetById = async () => {
    throw new Error("not found");
  };
  timeSlotFindUnique = async () => null;
  medusaStoreFetch = async () => ({});
  searchProductsMock = async () => ({ products: [] });
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
      products: [{ id: "prod_1", variants: [{ id: "var_coke" }], allergens: ["gluten"] }],
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
      products: [{ id: "p2", variants: [{ id: "var_water" }], allergens: [] }],
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
