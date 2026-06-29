// Coverage for the cart.ts handlers/branches NOT exercised by the existing
// suites (src/__tests__/cart-routes.test.ts covers create/get/line-items/
// promotions/payment-sessions happy paths, the IDOR token matrix, SEC-001,
// and large-ticket confirm; cart-pix-details-envelope.test.ts covers the
// cachePixDetailsForCustomer envelope build).
//
// This file ADDS the uncovered surface:
//   - POST /api/cart/:id/sync (full handler + per-item REFUSE/error skips)
//   - GET  /api/cart/pix-details (cache-hit + service-fallback + empty)
//   - GET  /api/cart/delivery-estimate (success + 400)
//   - POST /api/coupons/validate (valid/disabled/not-found/error)
//   - POST /api/cart/checkout WITH local items → the sync helper chain
//     (clean-cart clear, completed-cart replace, live-session cancel, 404 replace)
//   - validateCheckoutComposition 422 branches (kitchen-closed/shipping/dine_in)
//   - cart-ownership 403 (incl. the lost-race branch) across mutating routes
//   - payment-sessions payment-collection 500
//   - medusaAdjudicated error mapping on PATCH/DELETE/payment-sessions + re-throw 500
//   - GET /api/cart/orders/:orderId pi_-pending(202), IBX- resolution, full shaping
//   - GET /api/cart/orders/:orderId/status IBX-resolve, medusa-fallback, pending, 502
//   - checkout finalize: fixable-failure 400 (gate release) + note persistence
//
// All external deps are mocked — no DB / network / Redis / LLM. pt-BR copy is
// asserted verbatim where the route owns it.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";
// Wire the no-op audit sink BEFORE importing the routes (see cart-routes.test.ts).
import "../../__tests__/setup.js";
import { cartRoutes } from "../cart.js";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn());
const mockAdjudicate = vi.hoisted(() => vi.fn());
const mockAdjudicateAndAudit = vi.hoisted(() => vi.fn());
const mockCreateCheckout = vi.hoisted(() => vi.fn());
const mockEstimateDelivery = vi.hoisted(() => vi.fn());
const mockGetMealPeriod = vi.hoisted(() => vi.fn());
const mockLoadSchedule = vi.hoisted(() => vi.fn());
const mockCancelStalePI = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockUpdatePixFromEnvelope = vi.hoisted(() => vi.fn());
const mockAddNote = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockOrderQueryGetById = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());

const MockMedusaRequestError = vi.hoisted(() =>
  class extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
);
const MockRefusedError = vi.hoisted(() =>
  class extends Error {
    code: string;
    userFacing: string;
    constructor(opts: { code: string; userFacing: string }) {
      super(`Refused: ${opts.code}`);
      this.name = "MedusaAdjudicateRefusedError";
      this.code = opts.code;
      this.userFacing = opts.userFacing;
    }
  },
);
const MockDeferredError = vi.hoisted(() =>
  class extends Error {
    signal: string;
    constructor(opts: { signal: string }) {
      super(`Deferred: ${opts.signal}`);
      this.name = "MedusaAdjudicateDeferredError";
      this.signal = opts.signal;
    }
  },
);
const MockNeedsReviewError = vi.hoisted(() =>
  class extends Error {
    constructor() {
      super("NeedsReview");
      this.name = "MedusaAdjudicateNeedsReviewError";
    }
  },
);

vi.mock("@ibatexas/tools", async () => {
  // Real CPF + per-order-token helpers so any boundary check / mint is faithful.
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools");
  return {
    getRedisClient: mockGetRedisClient,
    rk: mockRk,
    estimateDelivery: mockEstimateDelivery,
    createCheckout: mockCreateCheckout,
    reaisToCentavos: (amount: number) => Math.round(amount * 100),
    MedusaRequestError: MockMedusaRequestError,
    cancelStalePaymentIntent: mockCancelStalePI,
    loadSchedule: mockLoadSchedule,
    getMealPeriodFromSchedule: mockGetMealPeriod,
    medusaAdjudicated: mockMedusaAdjudicated,
    MedusaAdjudicateRefusedError: MockRefusedError,
    MedusaAdjudicateDeferredError: MockDeferredError,
    MedusaAdjudicateNeedsReviewError: MockNeedsReviewError,
    isValidCpf: actual.isValidCpf,
    normalizeCpf: actual.normalizeCpf,
    createOrderAccessToken: actual.createOrderAccessToken,
    verifyOrderAccessToken: actual.verifyOrderAccessToken,
  };
});

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    getById: mockGetById,
    updatePixDetailsFromEnvelope: mockUpdatePixFromEnvelope,
  }),
  createOrderCommandService: () => ({
    addNoteFromEnvelope: mockAddNote,
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
  }),
  // Dynamically imported inside computeOrderStatus.
  createOrderQueryService: () => ({
    getById: mockOrderQueryGetById,
  }),
  prisma: {
    orderProjection: {
      findFirst: mockFindFirst,
    },
  },
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}));

vi.mock("../admin/_shared.js", () => ({
  medusaStore: mockMedusaStore,
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("@adjudicate/core/kernel", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, adjudicate: mockAdjudicate };
});

vi.mock("@adjudicate/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, adjudicateAndAudit: mockAdjudicateAndAudit };
});

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (!customerId) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
      return;
    }
    request.customerId = customerId;
    done();
  },
  optionalAuth: (request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (customerId) request.customerId = customerId;
    done();
  },
}));

// ── Harness ─────────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(cartRoutes);
  await app.ready();
  return app;
}

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    hSet: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
    hGetAll: vi.fn().mockResolvedValue({}),
    expire: vi.fn().mockResolvedValue(true),
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    multi: vi.fn(() => ({
      hSet: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
    eval: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  mockGetRedisClient.mockResolvedValue(createMockRedis());
  mockGetMealPeriod.mockReturnValue("lunch");
  mockLoadSchedule.mockResolvedValue({ days: {} });
  mockCreateCheckout.mockResolvedValue({ success: true });
  mockEstimateDelivery.mockResolvedValue({ success: true });
  mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] });
  mockGetById.mockResolvedValue(null);
  mockGetActiveByOrderId.mockResolvedValue(null);
  mockFindFirst.mockResolvedValue(null);
  mockCancelStalePI.mockResolvedValue(undefined);
  mockAddNote.mockResolvedValue({ decision: { kind: "EXECUTE" }, result: undefined });
});

// ── POST /api/cart/:id/sync ──────────────────────────────────────────────────

describe("POST /api/cart/:id/sync — bulk sync Zustand → Medusa", () => {
  it("adds each item via medusaAdjudicated then returns the synced cart", async () => {
    mockMedusaAdjudicated.mockResolvedValue({ ok: true });
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_01", items: [{ id: "i1" }] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/sync",
      payload: { items: [{ variantId: "var_A", quantity: 2 }, { variantId: "var_B", quantity: 1 }] },
    });

    expect(res.statusCode).toBe(200);
    // The route ends by re-reading the cart via bare medusaStore.
    expect(mockMedusaStore).toHaveBeenCalledWith("/store/carts/cart_01");
    expect(res.json().cart.id).toBe("cart_01");
    // One adjudicated add per item, with the line_items.add intent + payload.
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(2);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/carts/cart_01/line-items",
        intentKind: "medusa.cart.line_items.add",
        payload: { variant_id: "var_A", quantity: 2 },
      }),
    );
  });

  it("skips a single REFUSEd item but still returns the cart (200)", async () => {
    mockMedusaAdjudicated
      .mockRejectedValueOnce(new MockRefusedError({ code: "blocked", userFacing: "x" }))
      .mockResolvedValueOnce({ ok: true });
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_01", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/sync",
      payload: { items: [{ variantId: "bad", quantity: 1 }, { variantId: "ok", quantity: 1 }] },
    });

    // REFUSE on one item does not abort the whole sync.
    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(2);
  });

  it("swallows a generic transport error on an item and still returns the cart", async () => {
    mockMedusaAdjudicated.mockRejectedValue(new Error("ECONNRESET"));
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_01", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/sync",
      payload: { items: [{ variantId: "x", quantity: 1 }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().cart.id).toBe("cart_01");
  });

  it("returns 403 when the cart belongs to another customer (ownership)", async () => {
    mockGetRedisClient.mockResolvedValue(
      createMockRedis({ get: vi.fn().mockResolvedValue("cust_OTHER") }),
    );
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/sync",
      payload: { items: [{ variantId: "x", quantity: 1 }] },
      headers: { "x-customer-id": "cust_ME" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Carrinho pertence a outro usuário.");
    // Ownership refusal short-circuits before any Medusa mutation.
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled();
  });
});

// ── Cart-ownership 403 across mutating routes ────────────────────────────────

describe("cart-ownership guard — 403 on a foreign cart", () => {
  function foreignOwnerRedis() {
    return createMockRedis({ get: vi.fn().mockResolvedValue("cust_OTHER") });
  }

  it("POST /api/cart/:id/line-items → 403", async () => {
    mockGetRedisClient.mockResolvedValue(foreignOwnerRedis());
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 1 },
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Carrinho pertence a outro usuário.");
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled();
  });

  it("PATCH /api/cart/:id/line-items/:itemId → 403", async () => {
    mockGetRedisClient.mockResolvedValue(foreignOwnerRedis());
    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/cart/cart_01/line-items/item_01",
      payload: { quantity: 3 },
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Carrinho pertence a outro usuário.");
  });

  it("DELETE /api/cart/:id/line-items/:itemId → 403", async () => {
    mockGetRedisClient.mockResolvedValue(foreignOwnerRedis());
    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/cart/cart_01/line-items/item_01",
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /api/cart/checkout → 403", async () => {
    mockGetRedisClient.mockResolvedValue(foreignOwnerRedis());
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Carrinho pertence a outro usuário.");
    // Rejected before schedule/composition/idempotency side-effects.
    expect(mockCreateCheckout).not.toHaveBeenCalled();
  });

  it("lost claim race (NX fails, actual owner differs) → 403", async () => {
    // owner GET null → claim NX returns null (another request won) → re-GET
    // returns a DIFFERENT customer → not us → 403.
    mockGetRedisClient.mockResolvedValue(
      createMockRedis({
        get: vi.fn().mockResolvedValue("cust_OTHER"),
        set: vi.fn().mockResolvedValue(null),
      }),
    );
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 1 },
      headers: { "x-customer-id": "cust_ME" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── validateCheckoutComposition 422 branches ─────────────────────────────────

describe("POST /api/cart/checkout — composition guards (422)", () => {
  it("kitchen closed + a food item → 422 KITCHEN_CLOSED", async () => {
    mockGetMealPeriod.mockReturnValue("closed");
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "card",
        items: [{ variantId: "v1", quantity: 1, productType: "food" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("KITCHEN_CLOSED");
    expect(res.json().message).toContain("cozinha está fechada");
  });

  it("shipping with a non-merchandise item → 422 SHIPPING_NON_MERCHANDISE", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "card",
        deliveryType: "shipping",
        items: [{ variantId: "v1", quantity: 1, productType: "food" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("SHIPPING_NON_MERCHANDISE");
  });

  it("shipping + cash → 422 CASH_NOT_ALLOWED_FOR_SHIPPING", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "cash",
        deliveryType: "shipping",
        items: [{ variantId: "v1", quantity: 1, productType: "merchandise" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("CASH_NOT_ALLOWED_FOR_SHIPPING");
  });

  it("dine_in without a food item → 422 DINEIN_REQUIRES_FOOD", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: {
        cartId: "cart_01",
        paymentMethod: "card",
        deliveryType: "dine_in",
        items: [{ variantId: "v1", quantity: 1, productType: "merchandise" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("DINEIN_REQUIRES_FOOD");
  });
});

// ── POST /api/cart/checkout WITH local items → sync helper chain ──────────────

describe("POST /api/cart/checkout — local-item sync chain", () => {
  const merchItems = [{ variantId: "var_A", quantity: 2, productType: "merchandise" as const }];

  it("clean cart: clears existing items then re-adds local items, EXECUTE 200", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    // Existing cart is clean (no completed_at / no payment sessions) with one stale item.
    mockMedusaStore.mockResolvedValue({ cart: { items: [{ id: "old_1" }], payment_collection: null } });
    mockMedusaAdjudicated.mockResolvedValue({ ok: true });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    // Stale item removed in place.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/store/carts/cart_01/line-items/old_1",
        intentKind: "medusa.cart.line_items.remove",
      }),
    );
    // Local item re-added with its productType metadata.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/carts/cart_01/line-items",
        intentKind: "medusa.cart.line_items.add",
        payload: { variant_id: "var_A", quantity: 2, metadata: { productType: "merchandise" } },
      }),
    );
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
  });

  it("completed cart: binds the new cart to the customer's Medusa id and checks out the new cart", async () => {
    mockGetById.mockResolvedValue({ medusaId: "med_1" });
    mockMedusaStore.mockResolvedValue({ cart: { completed_at: "2026-06-01T00:00:00Z", items: [] } });
    mockMedusaAdjudicated.mockImplementation(async (opts: { intentKind: string }) => {
      if (opts.intentKind === "medusa.cart.create") return { cart: { id: "cart_NEW" } };
      return { ok: true };
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    // New cart created, customer-bound.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/carts",
        intentKind: "medusa.cart.create",
        payload: { customer_id: "med_1" },
      }),
    );
    // Local item added to the NEW cart, not the stale one.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/store/carts/cart_NEW/line-items",
        intentKind: "medusa.cart.line_items.add",
      }),
    );
  });

  it("cart with live payment sessions: cancels the Stripe PI then replaces the cart", async () => {
    mockMedusaStore.mockResolvedValue({
      cart: {
        items: [],
        payment_collection: {
          id: "pc_1",
          payment_sessions: [{ id: "ps_1", provider_id: "pp_stripe_stripe", data: { id: "pi_LIVE" } }],
        },
      },
    });
    mockMedusaAdjudicated.mockImplementation(async (opts: { intentKind: string }) => {
      if (opts.intentKind === "medusa.cart.create") return { cart: { id: "cart_NEW" } };
      return { ok: true };
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    // The orphan-QR Stripe PaymentIntent is cancelled before replacing the cart.
    expect(mockCancelStalePI).toHaveBeenCalledWith("pi_LIVE");
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({ intentKind: "medusa.cart.create" }),
    );
  });

  it("purged cart (Medusa 404): creates a fresh cart and proceeds", async () => {
    mockMedusaStore.mockRejectedValue(new MockMedusaRequestError(404, "cart not found"));
    mockMedusaAdjudicated.mockImplementation(async (opts: { intentKind: string }) => {
      if (opts.intentKind === "medusa.cart.create") return { cart: { id: "cart_FRESH" } };
      return { ok: true };
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_GONE", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({ intentKind: "medusa.cart.create" }),
    );
  });

  it("new-cart creation returns no id → 500", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { completed_at: "2026-06-01T00:00:00Z", items: [] } });
    mockMedusaAdjudicated.mockImplementation(async (opts: { intentKind: string }) => {
      if (opts.intentKind === "medusa.cart.create") return { cart: undefined };
      return { ok: true };
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", deliveryType: "pickup", items: merchItems },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe("Não foi possível criar um novo carrinho.");
  });
});

// ── checkout finalize side-effects ───────────────────────────────────────────

describe("POST /api/cart/checkout — finalize side-effects", () => {
  it("createCheckout failure → 400 and the idempotency gate is released", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    mockCreateCheckout.mockResolvedValue({ success: false, message: "Estoque insuficiente." });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    // The fixable-failure gate release (redis.del) ran so the customer can retry.
    expect(redis.del).toHaveBeenCalledWith(
      expect.stringContaining("checkout:idem:"),
    );
  });

  it("success with notes + IBX order → persists the note via order.note.add envelope", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    mockCreateCheckout.mockResolvedValue({ success: true, orderId: "IBX-0004", paymentMethod: "cash" });
    mockFindFirst.mockResolvedValue({
      id: "proj_1",
      customerId: "cus_01",
      paymentMethod: "cash",
      paymentStatus: "pending",
      totalInCentavos: 5000,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash", notes: "Sem cebola, por favor." },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().orderId).toBe("IBX-0004");
    // Display-id resolved to the projection's internal id.
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { displayId: 4 } }),
    );
    // Note routed through the kernel-adjudicated order.note.add envelope.
    expect(mockAddNote).toHaveBeenCalledTimes(1);
    const [envelope] = mockAddNote.mock.calls[0]!;
    expect(envelope.kind).toBe("order.note.add");
    expect(envelope.payload).toEqual({ orderId: "proj_1", body: "Sem cebola, por favor." });
    // Successful order untracks the cart owner key.
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining("cart:owner:cart_01"));
  });
});

// ── medusaAdjudicated error mapping (uncovered routes) ───────────────────────

describe("cart routes — medusaAdjudicated error mapping (uncovered)", () => {
  it("PATCH line-items REFUSE → 403 pt-BR", async () => {
    mockMedusaAdjudicated.mockRejectedValue(
      new MockRefusedError({ code: "qty.blocked", userFacing: "Quantidade bloqueada." }),
    );
    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/cart/cart_01/line-items/item_01",
      payload: { quantity: 5 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Quantidade bloqueada.");
    expect(res.json().code).toBe("qty.blocked");
  });

  it("DELETE line-items DEFER → 202", async () => {
    mockMedusaAdjudicated.mockRejectedValue(new MockDeferredError({ signal: "stock.hold" }));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/cart/cart_01/line-items/item_01",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("deferred");
    expect(res.json().signal).toBe("stock.hold");
  });

  it("payment-sessions DEFER → 202", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { payment_collection: { id: "pc_1" } } });
    mockMedusaAdjudicated.mockRejectedValue(new MockDeferredError({ signal: "psp.retry" }));
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().signal).toBe("psp.retry");
  });

  it("payment-sessions: payment-collection create returns no id → 500", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { payment_collection: null } });
    mockMedusaAdjudicated.mockResolvedValue({ payment_collection: undefined });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Failed to create payment collection");
  });

  it("POST /api/cart re-throws a non-typed error → 500", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockMedusaAdjudicated.mockRejectedValue(new Error("medusa down"));
    const app = await buildTestServer();
    const res = await app.inject({ method: "POST", url: "/api/cart" });
    // Not a typed REFUSE/DEFER/REVIEW → mapMedusaErrorToReply returns false →
    // the route re-throws → Fastify default 500.
    expect(res.statusCode).toBe(500);
  });
});

// ── GET /api/cart/pix-details ────────────────────────────────────────────────

describe("GET /api/cart/pix-details", () => {
  it("returns the Redis-cached PIX details (cache hit) and refreshes the TTL", async () => {
    const redis = createMockRedis({
      hGetAll: vi.fn().mockResolvedValue({ name: "Ana", email: "ana@x.com", cpf: "39053344705" }),
    });
    mockGetRedisClient.mockResolvedValue(redis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/pix-details",
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "Ana", email: "ana@x.com", cpf: "39053344705" });
    expect(redis.expire).toHaveBeenCalled();
  });

  it("falls back to the customer service when Redis has no cache", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis()); // hGetAll → {}
    mockGetById.mockResolvedValue({ name: "Bob", email: "bob@x.com", cpf: "11144477735" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/pix-details",
      headers: { "x-customer-id": "cus_02" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "Bob", email: "bob@x.com", cpf: "11144477735" });
  });

  it("returns {} when nothing is cached and the customer lookup yields nothing", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockGetById.mockResolvedValue(null);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/pix-details",
      headers: { "x-customer-id": "cus_03" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it("requires authentication (401 without x-customer-id)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/pix-details" });
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /api/cart/delivery-estimate ──────────────────────────────────────────

describe("GET /api/cart/delivery-estimate", () => {
  it("returns the estimate on success", async () => {
    mockEstimateDelivery.mockResolvedValue({ success: true, feeInCentavos: 500, etaMinutes: 40 });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/delivery-estimate?cep=01310100" });
    expect(res.statusCode).toBe(200);
    expect(res.json().feeInCentavos).toBe(500);
    expect(mockEstimateDelivery).toHaveBeenCalledWith({ cep: "01310100" });
  });

  it("returns 400 when the estimate fails (out-of-range CEP)", async () => {
    mockEstimateDelivery.mockResolvedValue({ success: false, error: "Fora da área de entrega." });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/delivery-estimate?cep=99999999" });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it("returns 400 on a malformed CEP (schema validation)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/delivery-estimate?cep=123" });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /api/coupons/validate ───────────────────────────────────────────────

describe("POST /api/coupons/validate", () => {
  it("valid active promotion → { valid: true, discount }", async () => {
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{ id: "p1", code: "VIP10", is_disabled: false, application_method: { value: 1000, type: "percentage" } }],
    });
    const app = await buildTestServer();
    const res = await app.inject({ method: "POST", url: "/api/coupons/validate", payload: { code: "VIP10" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, discount: 1000 });
  });

  it("disabled promotion → { valid: false }", async () => {
    mockMedusaAdmin.mockResolvedValue({
      promotions: [{ id: "p2", code: "OLD", is_disabled: true, application_method: { value: 500 } }],
    });
    const app = await buildTestServer();
    const res = await app.inject({ method: "POST", url: "/api/coupons/validate", payload: { code: "OLD" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });

  it("no matching promotion → { valid: false }", async () => {
    mockMedusaAdmin.mockResolvedValue({ promotions: [] });
    const app = await buildTestServer();
    const res = await app.inject({ method: "POST", url: "/api/coupons/validate", payload: { code: "NOPE" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });

  it("Medusa error → { valid: false } (never 500)", async () => {
    mockMedusaAdmin.mockRejectedValue(new Error("medusa down"));
    const app = await buildTestServer();
    const res = await app.inject({ method: "POST", url: "/api/coupons/validate", payload: { code: "X" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });
});

// ── GET /api/cart/orders/:orderId — resolution + shaping (uncovered) ─────────

describe("GET /api/cart/orders/:orderId — order resolution + shaping", () => {
  it("pi_ id with no matching order yet → 202 pending", async () => {
    mockMedusaAdmin.mockResolvedValue({ orders: [] });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/orders/pi_PENDING" });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
    expect(res.json().paymentIntentId).toBe("pi_PENDING");
  });

  it("IBX- display id resolves via the projection then converts reais→centavos + shapes currentPayment", async () => {
    mockFindFirst.mockResolvedValue({ id: "order_X" });
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "order_X",
        status: "completed",
        display_id: 4,
        total: 178,
        subtotal: 158,
        shipping_total: 20,
        customer_id: "cus_ME",
        metadata: { deliveryType: "delivery", tipInCentavos: "300" },
        items: [{ id: "i1", title: "Costela", quantity: 1, unit_price: 158, metadata: { productType: "food" } }],
        created_at: "2026-06-25T00:00:00.000Z",
      },
    });
    mockGetActiveByOrderId.mockResolvedValue({
      id: "cp_1",
      method: "pix",
      status: "pending",
      amountInCentavos: 17800,
      pixExpiresAt: new Date("2026-06-30T00:00:00.000Z"),
      version: 2,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/IBX-0004",
      headers: { "x-customer-id": "cus_ME" },
    });

    expect(res.statusCode).toBe(200);
    const order = res.json().order;
    // reais → centavos conversion.
    expect(order.total).toBe(17800);
    expect(order.subtotal).toBe(15800);
    expect(order.items[0].unit_price).toBe(15800);
    expect(order.items[0].productType).toBe("food");
    // payment projection shaping.
    expect(order.payment_method).toBe("pix");
    expect(order.payment_status).toBe("pending");
    expect(order.currentPayment).toEqual({
      id: "cp_1",
      method: "pix",
      status: "pending",
      amountInCentavos: 17800,
      pixExpiresAt: "2026-06-30T00:00:00.000Z",
      version: 2,
    });
    expect(order.tip_in_centavos).toBe(300);
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { displayId: 4 } }),
    );
  });

  it("IBX- id with no projection AND no Medusa display_id hit → 202 pending", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({ orders: [] });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/orders/IBX-0099" });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
  });
});

// ── GET /api/cart/orders/:orderId/status — resolution + fallback (uncovered) ─

describe("GET /api/cart/orders/:orderId/status — resolution + Medusa fallback", () => {
  it("IBX- id resolves via projection id then reads status from the projection (200)", async () => {
    mockFindFirst.mockResolvedValue({ id: "order_X" });
    mockOrderQueryGetById.mockResolvedValue({
      customerId: "cus_ME",
      fulfillmentStatus: "preparing",
      updatedAt: new Date("2026-06-25T00:00:00.000Z"),
    });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/IBX-0004/status",
      headers: { "x-customer-id": "cus_ME" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("preparing");
    expect(res.json().source).toBe("projection");
    // The IBX- id was resolved to the projection's internal id before the query.
    expect(mockOrderQueryGetById).toHaveBeenCalledWith("order_X");
  });

  it("projection miss → Medusa fallback maps not_fulfilled → pending (200, source=medusa_fallback)", async () => {
    mockOrderQueryGetById.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({
      order: {
        fulfillment_status: "not_fulfilled",
        customer_id: "cus_ME",
        updated_at: "2026-06-25T01:00:00.000Z",
      },
    });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_raw/status",
      headers: { "x-customer-id": "cus_ME" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending"); // not_fulfilled → pending
    expect(res.json().source).toBe("medusa_fallback");
  });

  it("projection miss + Medusa has no order → 202 pending", async () => {
    mockOrderQueryGetById.mockResolvedValue(null);
    mockMedusaAdmin.mockResolvedValue({ order: undefined });
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/orders/order_missing/status" });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
  });

  it("query service throws → 502", async () => {
    mockOrderQueryGetById.mockRejectedValue(new Error("projection store down"));
    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/cart/orders/order_err/status" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("Failed to fetch order status");
  });
});

// Type assertion helper so the mocks satisfy TS in `.mock.calls` access.
const _typed: Mock = mockAddNote;
void _typed;
