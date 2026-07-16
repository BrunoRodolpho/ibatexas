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
// FE-T09 (D-a) — order.amend.update_qty/remove_item's LIVE order-fetch +
// title-match hydration (resolveOrderLineItem), distinct from the stored
// OrderProjection `orderGetById` above.
let orderServiceGetOrder: (
  orderId: string,
  customerId?: string,
) => Promise<{ order: { items?: Array<{ id: string; title: string }> }; ownershipValid: boolean }> =
  async () => {
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
  }),
  createOrderService: () => ({
    getOrder: (orderId: string, customerId?: string) => orderServiceGetOrder(orderId, customerId),
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
  orderServiceGetOrder = async () => {
    throw new Error("order not found");
  };
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
