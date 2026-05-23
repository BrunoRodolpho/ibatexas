// Unit tests for Stripe webhook routes
// POST /api/webhooks/stripe — payment_intent.succeeded / payment_intent.payment_failed
//
// Task 12 (M3) coverage: Stripe-driven payment reconciliation is now
// envelope-mediated. The `Stripe webhook governance` suite asserts:
//   - The `payment.status.reconcile` envelope shape (kind, actor, taint, nonce).
//   - `nonce = event.id` produces a deterministic `intentHash` per Stripe
//     event (replay-safe).
//   - REFUSE / DEFER / ESCALATE decisions skip the executor without
//     surfacing 5xx to Stripe (no retry storm for governance-driven skips).
//   - The legacy bare-arg `reconcileFromWebhook` is NOT called (bypass-
//     detection: every webhook reconcile goes through the envelope path).

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { stripeWebhookRoutes } from "../routes/stripe-webhook.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockConstructEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockCapturePayment = vi.hoisted(() => vi.fn());
const mockReconcileFromWebhook = vi.hoisted(() => vi.fn());
const mockReconcileFromWebhookFromEnvelope = vi.hoisted(() => vi.fn());
const mockGetByStripePaymentIntentId = vi.hoisted(() => vi.fn());
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("stripe", () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  medusaAdmin: mockMedusaAdmin,
  medusaStore: vi.fn(),
  withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderService: () => ({
    markPaid: vi.fn().mockResolvedValue({ success: true }),
    cancel: vi.fn().mockResolvedValue({ success: true }),
    capturePayment: mockCapturePayment,
  }),
  createPaymentCommandService: () => ({
    create: vi.fn().mockResolvedValue({ id: "pay_01", version: 1 }),
    transitionStatus: vi.fn().mockResolvedValue({ id: "pay_01", version: 1 }),
    reconcileFromWebhook: mockReconcileFromWebhook,
    reconcileFromWebhookFromEnvelope: mockReconcileFromWebhookFromEnvelope,
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: vi.fn().mockResolvedValue(null),
    getByStripePaymentIntentId: mockGetByStripePaymentIntentId,
  }),
  createOrderEventLogService: () => ({
    append: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: mockGetAuditSinkEmit }),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../jobs/pix-expiry-monitor.js", () => ({
  markPixPaid: vi.fn().mockResolvedValue(undefined),
}));

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
    // Stripe events always carry a unix-seconds `created` timestamp.
    // Pinned so the envelope's deterministic-hash test sees a stable value.
    created: 1_700_000_000,
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
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
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
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
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
          { variant_id: "var_01", quantity: 2, unit_price: 89, title: "Costela", product_id: "prod_01" },
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
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  it("fetches order, captures payment, publishes event", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockCapturePayment.mockResolvedValueOnce({
      customerId: "cus_01",
      displayId: 42,
      customerEmail: "a@b.com",
      customerName: "Test",
      customerPhone: "+5511",
      totalInCentavos: 17800,
      subtotalInCentavos: 15800,
      shippingInCentavos: 2000,
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 2, priceInCentavos: 8900, title: "Costela" }],
      paymentMethod: "pix",
      deliveryType: "pickup",
      tipInCentavos: 0,
    });
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
    expect(mockCapturePayment).toHaveBeenCalledWith(
      "order_01",
      "pi_test_123",
      expect.anything(),
    );
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.placed",
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

    // Service returns null → already processed, no new order publishing
    mockCapturePayment.mockResolvedValueOnce(null);

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
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "order.placed",
      expect.anything(),
    );
  });

  it("skips when stripePaymentIntentId already set in order metadata", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    // Service returns null → pi already linked
    mockCapturePayment.mockResolvedValueOnce(null);

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
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "order.placed",
      expect.anything(),
    );
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
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
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
      "order.payment_failed",
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
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  it("returns 200 and ignores unknown event types", async () => {
    const event = {
      id: "evt_unknown",
      type: "invoice.payment_succeeded",
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

describe("POST /api/webhooks/stripe — charge.refunded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  it("publishes order.refunded event with correct payload", async () => {
    const event = {
      id: "evt_refund_01",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_test_123",
          amount_refunded: 5000,
          metadata: { medusaOrderId: "order_01" },
        },
      },
    };
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
      "order.refunded",
      expect.objectContaining({
        eventType: "order.refunded",
        orderId: "order_01",
        chargeId: "ch_test_123",
        amountRefunded: 5000,
      }),
    );
  });

  it("handles missing medusaOrderId gracefully (warn, no crash)", async () => {
    const event = {
      id: "evt_refund_02",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_test_456",
          amount_refunded: 3000,
          metadata: {},
        },
      },
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
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — charge.dispute.created", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  it("publishes order.disputed event with correct payload", async () => {
    const event = {
      id: "evt_dispute_01",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_test_123",
          amount: 8900,
          reason: "fraudulent",
          metadata: { medusaOrderId: "order_02" },
        },
      },
    };
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
      "order.disputed",
      expect.objectContaining({
        eventType: "order.disputed",
        orderId: "order_02",
        disputeId: "dp_test_123",
        amount: 8900,
        reason: "fraudulent",
      }),
    );
  });

  it("handles missing medusaOrderId in dispute metadata (publishes with null orderId)", async () => {
    const event = {
      id: "evt_dispute_02",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_test_456",
          amount: 5000,
          reason: "product_not_received",
          metadata: {},
        },
      },
    };
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
    // Disputes always publish — even without orderId (they're serious events)
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.disputed",
      expect.objectContaining({
        eventType: "order.disputed",
        orderId: null,
        disputeId: "dp_test_456",
        amount: 5000,
        reason: "product_not_received",
      }),
    );
  });
});

describe("POST /api/webhooks/stripe — payment_intent.canceled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  it("publishes order.canceled event with correct payload", async () => {
    const event = {
      id: "evt_cancel_01",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_cancel_123",
          cancellation_reason: "abandoned",
          metadata: { medusaOrderId: "order_03" },
        },
      },
    };
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
      "order.canceled",
      expect.objectContaining({
        eventType: "order.canceled",
        orderId: "order_03",
        stripePaymentIntentId: "pi_cancel_123",
        cancellationReason: "abandoned",
      }),
    );
  });

  it("handles missing medusaOrderId gracefully (warn, no crash)", async () => {
    const event = {
      id: "evt_cancel_02",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_cancel_456",
          cancellation_reason: "requested_by_customer",
          metadata: {},
        },
      },
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
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — processing error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    // Default: no Payment row found — reconciliation path exits early.
    // Tests that exercise the envelope path override this explicitly.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  it("returns 500 and removes idempotency key on processing error", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    // capturePayment service throws
    mockCapturePayment.mockRejectedValue(new Error("Medusa down"));

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

    // Idempotency key TTL should be shortened so retry can succeed after 5min
    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("evt_test_123"),
      expect.any(Number),
    );
  });
});

// ── Task 12 (M3) — kernel-gated webhook governance ─────────────────────────
//
// Every Stripe-driven payment reconcile flows through a
// `payment.status.reconcile` IntentEnvelope adjudicated by the kernel
// inside PaymentCommandService. These tests pin the envelope shape, the
// deterministic-hash invariant (replay safety), and the decision-branch
// behaviour so a future refactor cannot silently bypass the kernel gate.

describe("POST /api/webhooks/stripe — kernel-gated reconciliation (Task 12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  function setupReconcileContext() {
    // A Payment row exists for the PI — reconcile path engages the envelope.
    mockGetByStripePaymentIntentId.mockResolvedValue({
      id: "pay_01",
      orderId: "order_01",
      status: "awaiting_payment",
      method: "pix",
    });
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    return mockRedis;
  }

  it("captures envelope with payment.status.reconcile kind, SYSTEM taint, system actor, and nonce = event.id", async () => {
    setupReconcileContext();

    const event = createStripeEvent(
      "payment_intent.payment_failed",
      { last_payment_error: { message: "Declined" } },
      "evt_envelope_shape_01",
    );
    mockConstructEvent.mockReturnValue(event);

    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2 },
    });
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
    expect(mockReconcileFromWebhookFromEnvelope).toHaveBeenCalledTimes(1);
    const envelope = mockReconcileFromWebhookFromEnvelope.mock.calls[0]?.[0];
    expect(envelope).toMatchObject({
      version: 2,
      kind: "payment.status.reconcile",
      nonce: "evt_envelope_shape_01",
      actor: {
        principal: "system",
        sessionId: "stripe-webhook:evt_envelope_shape_01",
      },
      taint: "SYSTEM",
    });
    // intentHash is derived from kind+payload+nonce+actor+taint — present
    // and stable per the envelope contract.
    expect(typeof envelope.intentHash).toBe("string");
    expect(envelope.intentHash.length).toBeGreaterThan(0);
    // Payload carries Stripe identity for ops traceability + the executor's
    // ownership / idempotency / out-of-order guards.
    expect(envelope.payload).toMatchObject({
      paymentId: "pay_01",
      newStatus: "payment_failed",
      stripeEventId: "evt_envelope_shape_01",
      expectedOrderId: "order_01",
    });
    expect(typeof envelope.payload.stripeEventTimestamp).toBe("string");
  });

  it("EXECUTE decision: publishes payment.status_changed and the legacy bare-arg method is NEVER called", async () => {
    setupReconcileContext();

    const event = createStripeEvent(
      "payment_intent.payment_failed",
      { last_payment_error: { message: "Card declined" } },
      "evt_execute_01",
    );
    mockConstructEvent.mockReturnValue(event);

    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 5 },
    });
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

    // payment.status_changed reflects the kernel-approved reconcile.
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({
        eventType: "payment.status_changed",
        paymentId: "pay_01",
        newStatus: "payment_failed",
        version: 5,
        stripeEventId: "evt_execute_01",
      }),
    );

    // Bypass-detection: the legacy bare-arg method MUST stay dormant. If
    // a future refactor reroutes through `reconcileFromWebhook`, this
    // assertion blocks the merge.
    expect(mockReconcileFromWebhook).not.toHaveBeenCalled();
  });

  it("REFUSE decision: handler does NOT publish status_changed and still returns 200 to Stripe", async () => {
    setupReconcileContext();

    const event = createStripeEvent(
      "payment_intent.payment_failed",
      { last_payment_error: { message: "Declined" } },
      "evt_refuse_01",
    );
    mockConstructEvent.mockReturnValue(event);

    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "payment.terminal_state",
          category: "BUSINESS_RULE",
          userFacing: "Pagamento já está em estado final.",
        },
        basis: [],
      },
    });
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

    // 200 to Stripe — governance-driven skips MUST NOT trigger Stripe retry storms.
    expect(res.statusCode).toBe(200);

    // Mutation was NOT executed → no payment.status_changed event.
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "payment.status_changed",
      expect.anything(),
    );
    // Legacy bypass guard.
    expect(mockReconcileFromWebhook).not.toHaveBeenCalled();
  });

  it("DEFER decision: handler skips the mutation and returns 200", async () => {
    setupReconcileContext();

    const event = createStripeEvent(
      "payment_intent.payment_failed",
      {},
      "evt_defer_01",
    );
    mockConstructEvent.mockReturnValue(event);

    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: {
        kind: "DEFER",
        signal: "payment.confirmation",
        timeoutMs: 5 * 60_000,
        basis: [],
      },
    });
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
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "payment.status_changed",
      expect.anything(),
    );
  });

  it("ESCALATE decision: handler skips the mutation and returns 200", async () => {
    setupReconcileContext();

    const event = createStripeEvent(
      "payment_intent.payment_failed",
      {},
      "evt_escalate_01",
    );
    mockConstructEvent.mockReturnValue(event);

    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: {
        kind: "ESCALATE",
        to: "human",
        reason: "fraud_signal_detected",
        basis: [],
      },
    });
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
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "payment.status_changed",
      expect.anything(),
    );
  });

  it("EXECUTE with null result (executor's idempotency/terminal/ownership guard): no NATS publish", async () => {
    setupReconcileContext();

    const event = createStripeEvent(
      "payment_intent.payment_failed",
      {},
      "evt_execute_noop_01",
    );
    mockConstructEvent.mockReturnValue(event);

    // EXECUTE but the executor's own guards (terminal / out-of-order /
    // ownership mismatch / already-at-target) returned null without
    // writing — matches legacy bare-arg semantics.
    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: null,
    });
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
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "payment.status_changed",
      expect.anything(),
    );
  });

  it("deterministic intentHash: rebuilding the envelope for the same Stripe event produces the same hash (replay-safe)", async () => {
    setupReconcileContext();

    const event = createStripeEvent(
      "payment_intent.payment_failed",
      {},
      "evt_replay_safe_01",
    );
    mockConstructEvent.mockReturnValue(event);

    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2 },
    });
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const app1 = await buildTestServer();
    await app1.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });
    const firstEnvelope = mockReconcileFromWebhookFromEnvelope.mock.calls[0]?.[0];

    // Reset and replay the SAME Stripe event through a fresh server. The
    // envelope is rebuilt from scratch (no in-memory state survives) so
    // any non-determinism in the envelope construction surfaces here.
    mockReconcileFromWebhookFromEnvelope.mockClear();
    mockGetByStripePaymentIntentId.mockResolvedValue({
      id: "pay_01",
      orderId: "order_01",
      status: "awaiting_payment",
      method: "pix",
    });
    mockGetRedisClient.mockResolvedValue(
      createMockRedis({ set: vi.fn().mockResolvedValue("OK") }),
    );
    mockConstructEvent.mockReturnValue(event);

    const app2 = await buildTestServer();
    await app2.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });
    const secondEnvelope = mockReconcileFromWebhookFromEnvelope.mock.calls[0]?.[0];

    expect(firstEnvelope.intentHash).toBe(secondEnvelope.intentHash);
    expect(firstEnvelope.nonce).toBe("evt_replay_safe_01");
    expect(secondEnvelope.nonce).toBe("evt_replay_safe_01");
  });

  it("envelope is built for charge.refunded reconciliation as well (cross-event coverage)", async () => {
    setupReconcileContext();

    const event = {
      id: "evt_refund_envelope_01",
      type: "charge.refunded",
      created: 1_700_000_000,
      data: {
        object: {
          id: "ch_test_x",
          amount: 10000,
          amount_refunded: 10000,
          payment_intent: "pi_test_123",
          metadata: { medusaOrderId: "order_01" },
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 3 },
    });
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
    expect(mockReconcileFromWebhookFromEnvelope).toHaveBeenCalledTimes(1);
    const envelope = mockReconcileFromWebhookFromEnvelope.mock.calls[0]?.[0];
    expect(envelope).toMatchObject({
      kind: "payment.status.reconcile",
      nonce: "evt_refund_envelope_01",
      taint: "SYSTEM",
      actor: {
        principal: "system",
        sessionId: "stripe-webhook:evt_refund_envelope_01",
      },
    });
    expect(envelope.payload.newStatus).toBe("refunded");
  });
});
