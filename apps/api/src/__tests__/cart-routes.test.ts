// Unit tests for cart routes
// POST /api/cart, GET /api/cart/:id, POST /api/cart/:id/line-items,
// PATCH /api/cart/:id/line-items/:itemId, DELETE /api/cart/:id/line-items/:itemId,
// POST /api/cart/:id/promotions, POST /api/cart/:id/payment-sessions

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";
import { cartRoutes } from "../routes/cart.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
// P0-X9 follow-up: cart route mutations go through medusaAdjudicated.
// We mock it as a standalone function (NOT a passthrough to medusaStore)
// per the anti-theater rule — tests must assert the wrapper was called.
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn());

const MockMedusaRequestError = vi.hoisted(() =>
  class extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  }
);

// P0-X9: typed errors the wrapper can throw. Mocks need to be `instanceof`-able.
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

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  estimateDelivery: vi.fn(async () => ({ success: true })),
  createCheckout: vi.fn(async () => ({ success: true })),
  reaisToCentavos: (amount: number) => Math.round(amount * 100),
  MedusaRequestError: MockMedusaRequestError,
  cancelStalePaymentIntent: vi.fn().mockResolvedValue(undefined),
  loadSchedule: vi.fn().mockResolvedValue({ days: {} }),
  getMealPeriodFromSchedule: vi.fn().mockReturnValue("lunch"),
  medusaAdjudicated: mockMedusaAdjudicated,
  MedusaAdjudicateRefusedError: MockRefusedError,
  MedusaAdjudicateDeferredError: MockDeferredError,
  MedusaAdjudicateNeedsReviewError: MockNeedsReviewError,
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    getById: vi.fn().mockResolvedValue(null),
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: vi.fn().mockResolvedValue(null),
  }),
  prisma: {
    orderProjection: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
}));

vi.mock("../routes/admin/_shared.js", () => ({
  medusaStore: mockMedusaStore,
  medusaAdmin: mockMedusaAdmin,
}));

vi.mock("../middleware/auth.js", () => ({
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
    if (customerId) {
      request.customerId = customerId;
    }
    done();
  },
}));

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(cartRoutes);
  await app.ready();
  return app;
}

// ── Mock Redis client ─────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    hSet: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/cart — create cart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("creates a cart and tracks it in Redis (via medusaAdjudicated)", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // P0-X9: mutations go through medusaAdjudicated, NOT bare medusaStore.
    mockMedusaAdjudicated.mockResolvedValue({ cart: { id: "cart_01", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart",
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.cart.id).toBe("cart_01");

    // Cart ID tracked in Redis active:carts hash
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("active:carts"),
      "cart_01",
      expect.stringContaining("cart_01"),
    );

    // P0-X9 anti-theater: medusaAdjudicated WAS called with the
    // kernel-gated envelope shape. Bare medusaStore is NOT invoked
    // for this mutation.
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(1);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts",
        intentKind: "medusa.cart.create",
      }),
    );
    expect(mockMedusaStore).not.toHaveBeenCalled();
  });

  it("passes customer_id when authenticated", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockResolvedValue({ cart: { id: "cart_02", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(201);
    // Cart creation sends empty body — customer association happens via Medusa session
    // P0-X9: the payload (not the body string) is what the wrapper sees.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts",
        payload: {},
      }),
    );
  });

  it("creates anonymous cart without customer_id", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockResolvedValue({ cart: { id: "cart_03", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart",
    });

    expect(res.statusCode).toBe(201);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {},
        path: "/store/carts",
      }),
    );
  });
});

describe("GET /api/cart/:id — get cart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns cart data from Medusa", async () => {
    // Medusa v2 returns prices in reais — this is a passthrough proxy
    mockMedusaStore.mockResolvedValue({
      cart: {
        id: "cart_01",
        items: [
          { id: "item_01", variant_id: "var_01", quantity: 2, unit_price: 89 },
        ],
        total: 178,
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/cart_01",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cart.id).toBe("cart_01");
    expect(body.cart.items).toHaveLength(1);
    expect(body.cart.total).toBe(178);
  });

  it("calls medusaStore with correct path", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_xyz" } });

    const app = await buildTestServer();
    await app.inject({ method: "GET", url: "/api/cart/cart_xyz" });

    expect(mockMedusaStore).toHaveBeenCalledWith("/store/carts/cart_xyz");
  });
});

describe("POST /api/cart/:id/line-items — add item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("adds item to cart (via medusaAdjudicated) and tracks cart in Redis", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockResolvedValue({
      cart: {
        id: "cart_01",
        items: [{ id: "item_01", variant_id: "var_01", quantity: 1 }],
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 1 },
    });

    expect(res.statusCode).toBe(201);

    // Cart tracked in active:carts hash
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("active:carts"),
      "cart_01",
      expect.stringContaining("cart_01"),
    );

    // P0-X9: medusaAdjudicated called with the kernel-gated envelope
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts/cart_01/line-items",
        intentKind: "medusa.cart.line_items.add",
        payload: { variant_id: "var_01", quantity: 1 },
      }),
    );
    expect(mockMedusaStore).not.toHaveBeenCalled();
  });

  it("returns 400 when variant_id is missing", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { quantity: 1 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when quantity is 0", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 0 },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/cart/:id/line-items/:itemId — update quantity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("updates item quantity (via medusaAdjudicated)", async () => {
    mockMedusaAdjudicated.mockResolvedValue({
      cart: {
        id: "cart_01",
        items: [{ id: "item_01", variant_id: "var_01", quantity: 3 }],
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/cart/cart_01/line-items/item_01",
      payload: { quantity: 3 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts/cart_01/line-items/item_01",
        intentKind: "medusa.cart.line_items.update",
        payload: { quantity: 3 },
      }),
    );
  });

  it("returns 400 when quantity is invalid", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/cart/cart_01/line-items/item_01",
      payload: { quantity: -1 },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/cart/:id/line-items/:itemId — remove item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("removes item from cart (via medusaAdjudicated)", async () => {
    mockMedusaAdjudicated.mockResolvedValue({
      cart: { id: "cart_01", items: [] },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/cart/cart_01/line-items/item_01",
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "DELETE",
        path: "/store/carts/cart_01/line-items/item_01",
        intentKind: "medusa.cart.line_items.remove",
      }),
    );
  });
});

describe("POST /api/cart/:id/promotions — apply coupon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("applies promotion code to cart (via medusaAdjudicated)", async () => {
    mockMedusaAdjudicated.mockResolvedValue({
      cart: { id: "cart_01", discount_total: 10 },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: { promo_codes: ["PROMO10"] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts/cart_01/promotions",
        intentKind: "medusa.cart.promotion.apply",
        payload: { promo_codes: ["PROMO10"] },
      }),
    );
  });

  it("returns 400 when promo_codes is missing", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts multiple promo codes", async () => {
    mockMedusaAdjudicated.mockResolvedValue({
      cart: { id: "cart_01", discount_total: 20 },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: { promo_codes: ["PROMO10", "VIP20"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cart.discount_total).toBe(20);
  });
});

describe("POST /api/cart/:id/payment-sessions — initialize payment (v2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("creates payment collection then initializes session (both via medusaAdjudicated)", async () => {
    // The cart GET stays on bare medusaStore (read-only, not governed).
    mockMedusaStore.mockResolvedValueOnce({ cart: { id: "cart_01", payment_collection: null } });
    // Two adjudicated mutations: collection.create + session.create.
    mockMedusaAdjudicated
      .mockResolvedValueOnce({ payment_collection: { id: "pc_01" } })
      .mockResolvedValueOnce({ payment_session: { id: "ps_01", provider_id: "pp_stripe_stripe" } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });

    expect(res.statusCode).toBe(200);
    // First adjudicated call: payment-collection create
    expect(mockMedusaAdjudicated).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        path: "/store/payment-collections",
        intentKind: "medusa.payment_collection.create",
      }),
    );
    // Second adjudicated call: payment-session create
    expect(mockMedusaAdjudicated).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        path: "/store/payment-collections/pc_01/payment-sessions",
        intentKind: "medusa.payment_session.create",
      }),
    );
  });

  it("reuses existing payment collection (via medusaAdjudicated)", async () => {
    // Cart already has a payment collection — only ONE adjudicated call (session.create).
    mockMedusaStore.mockResolvedValueOnce({
      cart: { id: "cart_02", payment_collection: { id: "pc_existing" } },
    });
    mockMedusaAdjudicated.mockResolvedValueOnce({ payment_session: { id: "ps_02" } });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/cart/cart_02/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });

    // Should NOT create a new payment collection
    expect(mockMedusaAdjudicated).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "/store/payment-collections" }),
    );
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/payment-collections/pc_existing/payment-sessions",
        intentKind: "medusa.payment_session.create",
      }),
    );
  });
});

describe("GET /api/cart/orders/:orderId — IDOR check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 403/404 when order belongs to a different customer", async () => {
    // Medusa v2 returns prices in reais — route converts to centavos
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "order_01",
        status: "completed",
        display_id: 42,
        total: 178,
        subtotal: 158,
        shipping_total: 20,
        customer_id: "cust_OTHER",
        items: [],
        created_at: "2026-03-18T00:00:00.000Z",
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_01",
      headers: { "x-customer-id": "cust_ME" },
    });

    // Should return 404 (masking the existence of the order)
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toBe("Pedido não encontrado.");
  });

  it("returns order when customer_id matches", async () => {
    // Medusa v2 returns prices in reais — route converts to centavos
    mockMedusaAdmin.mockResolvedValue({
      order: {
        id: "order_02",
        status: "completed",
        display_id: 43,
        total: 89,
        subtotal: 89,
        shipping_total: 0,
        customer_id: "cust_ME",
        items: [{ id: "item_01", title: "Costela", quantity: 1, unit_price: 89 }],
        created_at: "2026-03-18T00:00:00.000Z",
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_02",
      headers: { "x-customer-id": "cust_ME" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.order.id).toBe("order_02");
  });

  it("returns 404 when order not found (unauthenticated)", async () => {
    // Route uses optionalAuth to support stripe-return polling for PIX orders
    mockMedusaAdmin.mockResolvedValue({ order: undefined });
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_not_found",
      // No x-customer-id header
    });

    expect(res.statusCode).toBe(404);
  });
});

// ── SEC-001: Cash/PIX checkout auth gate ────────────────────────────────────

describe("POST /api/cart/checkout — SEC-001 cash/PIX auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    // NEW-P0-X2: order.checkout.create is not in ALWAYS_ENFORCE; without
    // shadow/enforce env the gateway now default-REFUSES. Tests that
    // exercise the legacy checkout path must opt in to shadow telemetry
    // mode (or enforce mode); shadow preserves the legacy EXECUTE.
    vi.stubEnv("IBX_KERNEL_SHADOW", "order.checkout.create");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("guest checkout with card → 200 OK", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "card" },
      // No x-customer-id — guest
    });

    expect(res.statusCode).toBe(200);
  });

  it("guest checkout with cash → 401", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      // No x-customer-id — guest
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toContain("Autenticação necessária");
    expect(body.message).toContain("dinheiro/PIX");
  });

  it("guest checkout with PIX → 401", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "pix" },
      // No x-customer-id — guest
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toContain("Autenticação necessária");
  });

  it("authenticated checkout with cash → 200 OK", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "cash" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("authenticated checkout with PIX → 200 OK", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/checkout",
      payload: { cartId: "cart_01", paymentMethod: "pix" },
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
  });
});

// ── P0-X9 — medusaAdjudicated error mapping ────────────────────────────────
//
// Anti-theater: tests that the typed errors from the wrapper map to the
// expected pt-BR HTTP responses. If a future refactor accidentally swallows
// REFUSE / DEFER / NEEDS_REVIEW, these assertions break.

describe("Cart routes — medusaAdjudicated error mapping (P0-X9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("POST /api/cart → 403 with pt-BR copy on REFUSE", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockRejectedValue(
      new MockRefusedError({
        code: "cart.create.blocked",
        userFacing: "Criação de carrinho bloqueada.",
      }),
    );

    const app = await buildTestServer();
    const res = await app.inject({ method: "POST", url: "/api/cart" });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("Criação de carrinho bloqueada.");
    expect(body.code).toBe("cart.create.blocked");
  });

  it("POST /api/cart/:id/line-items → 202 on DEFER", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockRejectedValue(
      new MockDeferredError({ signal: "inventory.replenish" }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/line-items",
      payload: { variant_id: "var_01", quantity: 1 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("deferred");
    expect(body.signal).toBe("inventory.replenish");
  });

  it("POST /api/cart/:id/promotions → 503 on NEEDS_REVIEW", async () => {
    mockMedusaAdjudicated.mockRejectedValue(new MockNeedsReviewError());

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: { promo_codes: ["VIP"] },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toContain("atendimento humano");
  });
});
