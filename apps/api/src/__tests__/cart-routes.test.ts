// Unit tests for cart routes
// POST /api/cart, GET /api/cart/:id, POST /api/cart/:id/line-items,
// PATCH /api/cart/:id/line-items/:itemId, DELETE /api/cart/:id/line-items/:itemId,
// POST /api/cart/:id/promotions, POST /api/cart/:id/payment-sessions

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("../routes/admin/_shared.js", () => ({
  medusaStore: mockMedusaStore,
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (request: any, reply: any, done: any) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (!customerId) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
    } else {
      request.customerId = customerId;
    }
    done();
  },
  optionalAuth: (request: any, _reply: any, done: any) => {
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
    sAdd: vi.fn().mockResolvedValue(1),
    sRem: vi.fn().mockResolvedValue(1),
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

    // Cart ID tracked in Redis active:carts set
    expect(mockRedis.sAdd).toHaveBeenCalledWith(
      expect.stringContaining("active:carts"),
      "cart_01",
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
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("cus_01"),
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
    mockMedusaStore.mockResolvedValue({
      cart: {
        id: "cart_01",
        items: [
          { id: "item_01", variant_id: "var_01", quantity: 2, unit_price: 8900 },
        ],
        total: 17800,
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
    expect(body.cart.total).toBe(17800);
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

    // Cart tracked in active:carts
    expect(mockRedis.sAdd).toHaveBeenCalledWith(
      expect.stringContaining("active:carts"),
      "cart_01",
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
    mockMedusaStore.mockResolvedValue({
      cart: { id: "cart_01", discount_total: 1000 },
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
    mockMedusaStore.mockResolvedValue({
      cart: { id: "cart_01", discount_total: 2000 },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/promotions",
      payload: { promo_codes: ["PROMO10", "VIP20"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cart.discount_total).toBe(2000);
  });
});

describe("POST /api/cart/:id/payment-sessions — initialize payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("initializes payment sessions for cart", async () => {
    mockMedusaStore.mockResolvedValue({
      cart: {
        id: "cart_01",
        payment_sessions: [{ provider_id: "stripe" }],
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/cart_01/payment-sessions",
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts/cart_01/payment-sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("calls the correct Medusa endpoint", async () => {
    mockMedusaStore.mockResolvedValue({ cart: { id: "cart_special" } });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/cart/cart_special/payment-sessions",
    });

    expect(mockMedusaStore).toHaveBeenCalledWith(
      "/store/carts/cart_special/payment-sessions",
      expect.anything(),
    );
  });
});
