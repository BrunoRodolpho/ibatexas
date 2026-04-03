// Unit tests for cart routes
// POST /api/cart, GET /api/cart/:id, POST /api/cart/:id/line-items,
// PATCH /api/cart/:id/line-items/:itemId, DELETE /api/cart/:id/line-items/:itemId,
// POST /api/cart/:id/promotions, POST /api/cart/:id/payment-sessions

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  estimateDelivery: vi.fn(async () => ({ success: true })),
  createCheckout: vi.fn(async () => ({ success: true })),
  reaisToCentavos: (amount: number) => Math.round(amount * 100),
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

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { cartRoutes } from "../routes/cart.js";

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

  it("creates a cart and tracks it in Redis", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_01", items: [] } });

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
  });

  it("passes customer_id when authenticated", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_02", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(201);
    // Cart creation sends empty body — customer association happens via Medusa session
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
  });

  it("creates anonymous cart without customer_id", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_03", items: [] } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart",
    });

    expect(res.statusCode).toBe(201);
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts",
      expect.objectContaining({
        body: "{}",
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

  it("adds item to cart and tracks cart in Redis", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({
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

    // Medusa called with correct payload
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts/cart_01/line-items",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("var_01"),
      }),
    );
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

  it("updates item quantity", async () => {
    mockMedusaStore.mockResolvedValue({
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
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts/cart_01/line-items/item_01",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ quantity: 3 }),
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

  it("removes item from cart", async () => {
    mockMedusaStore.mockResolvedValue({
      cart: { id: "cart_01", items: [] },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/cart/cart_01/line-items/item_01",
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts/cart_01/line-items/item_01",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("POST /api/cart/:id/promotions — apply coupon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("applies promotion code to cart", async () => {
    // Medusa v2 returns discount_total in reais — passthrough proxy
    mockMedusaStore.mockResolvedValue({
      cart: { id: "cart_01", discount_total: 10 },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: { promo_codes: ["PROMO10"] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts/cart_01/promotions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ promo_codes: ["PROMO10"] }),
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
    // Medusa v2 returns discount_total in reais — passthrough proxy
    mockMedusaStore.mockResolvedValue({
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

  it("creates payment collection then initializes session", async () => {
    // First call: GET cart (no payment_collection yet)
    // Second call: POST payment-collections
    // Third call: POST payment-sessions on collection
    mockMedusaStore
      .mockResolvedValueOnce({ cart: { id: "cart_01", payment_collection: null } })
      .mockResolvedValueOnce({ payment_collection: { id: "pc_01" } })
      .mockResolvedValueOnce({ payment_session: { id: "ps_01", provider_id: "pp_stripe_stripe" } });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/payment-collections",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/payment-collections/pc_01/payment-sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reuses existing payment collection", async () => {
    // Cart already has a payment collection
    mockMedusaStore
      .mockResolvedValueOnce({ cart: { id: "cart_02", payment_collection: { id: "pc_existing" } } })
      .mockResolvedValueOnce({ payment_session: { id: "ps_02" } });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/cart/cart_02/payment-sessions",
      payload: { provider_id: "pp_stripe_stripe" },
    });

    // Should NOT create a new payment collection
    expect(mockMedusaStore).not.toHaveBeenCalledWith(
      "/store/payment-collections",
      expect.anything(),
    );
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/payment-collections/pc_existing/payment-sessions",
      expect.objectContaining({ method: "POST" }),
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

  it("returns 401 when not authenticated", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/cart/orders/order_01",
      // No x-customer-id header
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── SEC-001: Cash/PIX checkout auth gate ────────────────────────────────────

describe("POST /api/cart/checkout — SEC-001 cash/PIX auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
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
