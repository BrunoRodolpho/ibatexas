// Unit tests for Stripe webhook routes
// POST /api/webhooks/stripe — payment_intent.succeeded / payment_intent.payment_failed

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockConstructEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());

vi.mock("stripe", () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("./admin/_shared.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}));

// The route imports medusaAdmin from "./admin/_shared.js" but the test resolves
// relative to routes/. We need to mock the exact import path from the route file's perspective.
vi.mock("../routes/admin/_shared.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}));

// ── Server factory ─────────────────────────────────────────────────────────────

import Fastify from "fastify";
import { stripeWebhookRoutes } from "../routes/stripe-webhook.js";

async function buildTestServer() {
  const app = Fastify({ logger: false });
  await app.register(stripeWebhookRoutes);
  await app.ready();
  return app;
}

// ── Mock Redis client ─────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function setupEnv() {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_secret");
}

function createStripeEvent(
  type: string,
  paymentIntent: Record<string, unknown> = {},
  id = "evt_test_123",
) {
  return {
    id,
    type,
    data: {
      object: {
        id: "pi_test_123",
        metadata: { medusaOrderId: "order_01" },
        last_payment_error: null,
        ...paymentIntent,
      },
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/webhooks/stripe — configuration checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 500 when STRIPE_WEBHOOK_SECRET is not set", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=abc",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toContain("not configured");
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    setupEnv();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain("Missing stripe-signature");
  });

  it("returns 400 when signature verification fails", async () => {
    setupEnv();
    mockConstructEvent.mockImplementation(() => {
      throw new Error("Signature verification failed");
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=invalid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain("verification failed");
  });
});

describe("POST /api/webhooks/stripe — idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 with duplicate:true for already-processed event", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    // SET NX returns null → event already processed
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.duplicate).toBe(true);
    expect(mockMedusaAdmin).not.toHaveBeenCalled();
  });

  it("processes new event (not duplicate)", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdmin.mockResolvedValueOnce({
      order: {
        status: "pending",
        customer_id: "cus_01",
        items: [
          { variant_id: "var_01", quantity: 2, unit_price: 8900, title: "Costela", product_id: "prod_01" },
        ],
      },
    });
    mockMedusaAdmin.mockResolvedValueOnce({}); // capture-payment
    mockMedusaAdmin.mockResolvedValueOnce({}); // update metadata
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("POST /api/webhooks/stripe — payment_intent.succeeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("fetches order, captures payment, publishes event", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdmin.mockResolvedValueOnce({
      order: {
        status: "pending",
        customer_id: "cus_01",
        items: [
          { variant_id: "var_01", quantity: 2, unit_price: 8900, title: "Costela", product_id: "prod_01" },
        ],
      },
    });
    mockMedusaAdmin.mockResolvedValueOnce({}); // capture-payment
    mockMedusaAdmin.mockResolvedValueOnce({}); // update metadata
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);

    // Fetch order
    expect(mockMedusaAdmin).toHaveBeenCalledWith(
      expect.stringContaining("/admin/orders/order_01"),
    );

    // Capture payment
    expect(mockMedusaAdmin).toHaveBeenCalledWith(
      expect.stringContaining("/admin/orders/order_01/capture-payment"),
      expect.objectContaining({ method: "POST" }),
    );

    // Publish order.placed event
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "ibatexas.order.placed",
      expect.objectContaining({
        eventType: "order.placed",
        orderId: "order_01",
        customerId: "cus_01",
        items: expect.arrayContaining([
          expect.objectContaining({
            productId: "prod_01",
            variantId: "var_01",
            quantity: 2,
            priceInCentavos: 8900,
          }),
        ]),
      }),
    );
  });

  it("skips processing when order is not pending (already processed)", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdmin.mockResolvedValueOnce({
      order: {
        status: "completed",
        customer_id: "cus_01",
        items: [],
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    // Only 1 call to fetch order — no capture-payment call
    expect(mockMedusaAdmin).toHaveBeenCalledTimes(1);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("skips when stripePaymentIntentId already set in order metadata", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdmin.mockResolvedValueOnce({
      order: {
        status: "pending",
        customer_id: "cus_01",
        metadata: { stripePaymentIntentId: "pi_already_set" },
        items: [],
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdmin).toHaveBeenCalledTimes(1);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("warns and returns 200 when medusaOrderId is missing", async () => {
    const event = createStripeEvent("payment_intent.succeeded", {
      metadata: {},
    });
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    expect(mockMedusaAdmin).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — payment_intent.payment_failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("publishes order.payment_failed event", async () => {
    const event = createStripeEvent("payment_intent.payment_failed", {
      last_payment_error: { message: "Card declined" },
    });
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "ibatexas.order.payment_failed",
      expect.objectContaining({
        eventType: "order.payment_failed",
        orderId: "order_01",
        stripePaymentIntentId: "pi_test_123",
        lastPaymentError: "Card declined",
      }),
    );
  });

  it("handles payment_failed without orderId gracefully", async () => {
    const event = createStripeEvent("payment_intent.payment_failed", {
      metadata: {},
    });
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — unknown event type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 and ignores unknown event types", async () => {
    const event = {
      id: "evt_unknown",
      type: "charge.refunded",
      data: { object: {} },
    };
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockMedusaAdmin).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — processing error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 500 and removes idempotency key on processing error", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    // Medusa fetch throws
    mockMedusaAdmin.mockRejectedValue(new Error("Medusa down"));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toContain("Internal processing error");

    // Idempotency key should be removed so retry can succeed
    expect(mockRedis.del).toHaveBeenCalledWith(
      expect.stringContaining("evt_test_123"),
    );
  });
});
