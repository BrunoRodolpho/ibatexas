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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { stripeWebhookRoutes } from "../routes/stripe-webhook.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockConstructEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
// P0-PAY-2: swappable withLock so the double-capture concurrency test can install
// a real try-lock; defaults to pass-through so existing suites are unaffected.
const lockState = vi.hoisted(() => ({
  impl: async (_key: string, fn: () => Promise<unknown>): Promise<unknown> => fn(),
}));
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn());
const mockCapturePayment = vi.hoisted(() => vi.fn());
const mockReconcileFromWebhook = vi.hoisted(() => vi.fn());
const mockReconcileFromWebhookFromEnvelope = vi.hoisted(() => vi.fn());
const mockDisputeOpenFromEnvelope = vi.hoisted(() => vi.fn());
const mockGetByStripePaymentIntentId = vi.hoisted(() => vi.fn());
// T2-1: orderId fallback for the reconcile PI lookup — hoisted so the
// fallback suite can assert adoption/non-adoption.
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// W8-V2: PIX cart-complete persists the orderId back to the PaymentIntent
// through stripeAdjudicated rather than a bare Stripe SDK call. Mock it
// here so tests can assert the wrapper is called instead of the bare SDK.
const mockStripeAdjudicatedUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({}));
// W8-V2: bare Stripe SDK paymentIntents.update — exposed as a hoisted
// mock so the bypass-sentinel test below can assert it is NEVER invoked
// for the metadata-persist path.
const mockBareStripePaymentIntentsUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({}));

// P0-X9: typed errors from medusaAdjudicated. Mocked for instanceof checks.
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

vi.mock("stripe", () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
    // W8-V2: production code now routes the metadata-update through
    // stripeAdjudicated. The bare SDK update mock stays here so the
    // bypass-sentinel test below can confirm it is NEVER invoked.
    paymentIntents = {
      update: mockBareStripePaymentIntentsUpdate,
    };
  },
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  medusaAdmin: mockMedusaAdmin,
  medusaStore: mockMedusaStore,
  withLock: vi.fn((key: string, fn: () => Promise<unknown>) => lockState.impl(key, fn)),
  medusaAdjudicated: mockMedusaAdjudicated,
  MedusaAdjudicateRefusedError: MockRefusedError,
  MedusaAdjudicateDeferredError: MockDeferredError,
  MedusaAdjudicateNeedsReviewError: MockNeedsReviewError,
  // W8-V2: typed errors + wrapper for the stripe-egress on metadata-persist.
  stripeAdjudicated: {
    paymentIntents: {
      update: mockStripeAdjudicatedUpdate,
    },
  },
  StripeAdjudicateRefusedError: MockRefusedError,
  StripeAdjudicateDeferredError: MockDeferredError,
  StripeAdjudicateNeedsReviewError: MockNeedsReviewError,
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
    disputeOpenFromEnvelope: mockDisputeOpenFromEnvelope,
  }),
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    getByStripePaymentIntentId: mockGetByStripePaymentIntentId,
  }),
  createOrderEventLogService: () => ({
    append: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: () => ({ emit: mockGetAuditSinkEmit }),
}));

vi.mock("../jobs/pix-expiry-monitor.js", () => ({
  markPixPaid: vi.fn().mockResolvedValue(undefined),
}));

// Ack-then-async (P1-NET-STRIPESYNC): the route now enqueues a durable job
// instead of running handlers inline. By DEFAULT the enqueue mock synchronously
// dispatches the event through the real handler switch, so every existing
// handler-effect suite (capture / NATS / reconcile / PIX / double-capture /
// PIXDUP) keeps exercising the (now-async) handlers via the injected request.
// The dedicated ack-then-async suite overrides this per-test.
const mockEnqueueStripeWebhookEvent = vi.hoisted(() =>
  vi.fn(async (event: unknown, receivedAtMs: number) => {
    const { dispatchStripeWebhookEvent } = await import("../routes/stripe-webhook.js");
    await dispatchStripeWebhookEvent(event as never, receivedAtMs, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  }),
);
const mockStartStripeWebhookProcessor = vi.hoisted(() => vi.fn());

vi.mock("../jobs/stripe-webhook-processor.js", () => ({
  enqueueStripeWebhookEvent: mockEnqueueStripeWebhookEvent,
  startStripeWebhookProcessor: mockStartStripeWebhookProcessor,
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
    livemode: false,
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
      livemode: false,
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
      livemode: false,
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
      livemode: false,
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
      livemode: false,
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
      livemode: false,
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

  it("BKL-178: ESCALATE → mints the dispute.open envelope and publishes support.handoff_requested", async () => {
    const event = {
      id: "evt_dispute_03",
      livemode: false,
      created: 1_700_000_000,
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_test_789",
          amount: 12000,
          reason: "fraudulent",
          payment_intent: "pi_disputed_1",
          metadata: { medusaOrderId: "order_03" },
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    // The chargeback's Payment row resolves (reconcile + dispute.open both find it).
    mockGetByStripePaymentIntentId.mockResolvedValue({
      id: "pay_09",
      orderId: "order_03",
      status: "disputed",
      method: "pix",
      stripePaymentIntentId: "pi_disputed_1",
    });
    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { version: 2 },
    });
    mockDisputeOpenFromEnvelope.mockResolvedValue({
      decision: { kind: "ESCALATE", reason: "dispute_opened_requires_review" },
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
    // The system-actor dispute.open envelope carries the resolved paymentId, the
    // Stripe event.id as both stripeEventId + nonce, and the chargeback amount.
    expect(mockDisputeOpenFromEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "payment.dispute.open",
        payload: expect.objectContaining({
          paymentId: "pay_09",
          stripeEventId: "evt_dispute_03",
          disputeAmountCentavos: 12000,
        }),
        nonce: "evt_dispute_03",
        actor: expect.objectContaining({ principal: "system" }),
        taint: "SYSTEM",
      }),
    );
    // The missing edge — the audited ESCALATE surfaces on the owner escalation
    // queue via the handoff subscriber (which also pings staff).
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "support.handoff_requested",
      expect.objectContaining({
        sessionId: "dispute:dp_test_789",
        reason: "payment_disputed",
      }),
    );
  });

  it("BKL-178: a non-ESCALATE dispute.open decision publishes NO handoff (fires on ESCALATE only)", async () => {
    const event = {
      id: "evt_dispute_04",
      livemode: false,
      created: 1_700_000_000,
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_test_999",
          amount: 7000,
          reason: "fraudulent",
          payment_intent: "pi_disputed_2",
          metadata: { medusaOrderId: "order_04" },
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockGetByStripePaymentIntentId.mockResolvedValue({
      id: "pay_10",
      orderId: "order_04",
      status: "disputed",
      method: "pix",
      stripePaymentIntentId: "pi_disputed_2",
    });
    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { version: 2 },
    });
    // Defensive branch — a policy-contract change that stops escalating. The
    // handoff must NOT fire; the reconcile still recorded the DISPUTED truth.
    mockDisputeOpenFromEnvelope.mockResolvedValue({
      decision: { kind: "REFUSE", refusal: { code: "x", kind: "BUSINESS_RULE", userFacing: "x" } },
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
    const handoffCalls = mockPublishNatsEvent.mock.calls.filter(
      (c) => c[0] === "support.handoff_requested",
    );
    expect(handoffCalls).toHaveLength(0);
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
      livemode: false,
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
      livemode: false,
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

describe("POST /api/webhooks/stripe — ack-then-async enqueue contract (P1-NET-STRIPESYNC)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  it("enqueues a durable job and returns 200 WITHOUT running handlers inline", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: vi.fn().mockResolvedValue("OK") }));

    // Override the default sync-dispatch with a non-dispatching stub so we can
    // prove the ROUTE does NOT run the heavy work inline — it only enqueues.
    mockEnqueueStripeWebhookEvent.mockImplementationOnce(async () => undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=valid" },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Enqueued with the verified event; the heavy handler work did NOT run inline.
    expect(mockEnqueueStripeWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockEnqueueStripeWebhookEvent.mock.calls[0][0]).toMatchObject({ id: "evt_test_123" });
    expect(mockCapturePayment).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("on ENQUEUE failure, downgrades the idempotency key to 300s and returns 500 (Stripe retries)", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    // The enqueue itself fails (Redis/BullMQ down) — the claimed key must NOT
    // suppress Stripe's retry, so it is downgraded to a short TTL + we 500.
    mockEnqueueStripeWebhookEvent.mockRejectedValueOnce(new Error("queue unavailable"));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=valid" },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("enqueue");
    // Key TTL shortened to 300s so Stripe's retry re-opens the window.
    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("evt_test_123"),
      300,
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
      livemode: false,
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

// ── P0-X9: PIX cart-complete via medusaAdjudicated ─────────────────────────
//
// The PIX flow's deferred cart-complete (when payment succeeds but the cart
// was never completed at checkout) was bypassing medusaAdjudicated() —
// the bare medusaStore POST to /store/carts/<id>/complete escaped audit
// + kernel governance. Migrated in the P0-X9 follow-up. These tests pin
// the new envelope shape AND the kernel-skip-without-Stripe-retry contract.

describe("POST /api/webhooks/stripe — PIX cart-complete via medusaAdjudicated (P0-X9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
  });

  function createPixEvent(eventId = "evt_pix_complete_01", cartId = "cart_pix_01") {
    return {
      id: eventId,
      livemode: false,
      type: "payment_intent.succeeded",
      created: 1_700_000_000,
      data: {
        object: {
          id: "pi_pix_123",
          metadata: { cartId },
          // medusaOrderId is intentionally absent — that's what triggers
          // the cart-complete branch.
          last_payment_error: null,
        },
      },
    };
  }

  it("completes the cart via medusaAdjudicated with event.id as idempotencyKey + webhook sourceSubject", async () => {
    const event = createPixEvent("evt_pix_complete_42");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdjudicated.mockResolvedValue({
      type: "order",
      order: { id: "order_pix_01", display_id: 100 },
    });
    // capturePayment runs after cart-complete creates orderId. We don't
    // assert against it in this test; just make sure it doesn't blow up.
    mockCapturePayment.mockResolvedValue(null);

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

    // medusaAdjudicated WAS called with the expected envelope shape.
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = mockMedusaAdjudicated.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      scope: "store",
      method: "POST",
      path: "/store/carts/cart_pix_01/complete",
      intentKind: "medusa.cart.complete",
      idempotencyKey: "evt_pix_complete_42",
      sourceSubject: "webhook:stripe:evt_pix_complete_42",
    });
    expect(args.payload).toEqual({});
  });

  it("ack to Stripe with 200 + skip order creation when kernel REFUSES (no retry storm)", async () => {
    const event = createPixEvent("evt_pix_refuse_01");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdjudicated.mockRejectedValue(
      new MockRefusedError({
        code: "cart.complete.terminal",
        userFacing: "Carrinho já finalizado.",
      }),
    );

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

    // 200 to Stripe — governance-driven skips MUST NOT trigger retries
    expect(res.statusCode).toBe(200);
    // No order.placed event because no order was created
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "order.placed",
      expect.anything(),
    );
  });

  it("ack with 200 when kernel DEFERS (e.g. inventory replenish wait)", async () => {
    const event = createPixEvent("evt_pix_defer_01");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdjudicated.mockRejectedValue(
      new MockDeferredError({ signal: "inventory.replenish" }),
    );

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

  it("the legacy bare medusaStore is NOT called for the cart-complete (bypass-detection sentinel)", async () => {
    const event = createPixEvent("evt_pix_bypass_check_01");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdjudicated.mockResolvedValue({
      order: { id: "order_pix_02" },
    });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    // The bare medusaStore transport MUST stay dormant for this mutation.
    // If a future refactor reverts to medusaStore, this assertion blocks it.
    expect(mockMedusaStore).not.toHaveBeenCalledWith(
      expect.stringContaining("/store/carts/"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

// ── W8-V2 (NEW-W7-V2): PIX cart-complete metadata-update via stripeAdjudicated ──
//
// The bare `stripe.paymentIntents.update(...)` at stripe-webhook.ts:308
// was the last surviving stripe.* bypass in apps/api/src/routes/ after
// W7-P5 closed the cart-tool sites. W8-V2 routes it through the
// `stripeAdjudicated.paymentIntents.update(...)` wrapper so the
// metadata-persist mutation gets a `stripe.payment_intent.update`
// envelope, kernel adjudication, and an audit record.

describe("POST /api/webhooks/stripe — PIX cart-complete metadata-update via stripeAdjudicated (W8-V2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
    mockStripeAdjudicatedUpdate.mockResolvedValue({});
    mockBareStripePaymentIntentsUpdate.mockResolvedValue({});
  });

  function createPixEvent(
    eventId = "evt_pix_meta_update_01",
    cartId = "cart_pix_01",
  ) {
    return {
      id: eventId,
      livemode: false,
      type: "payment_intent.succeeded",
      created: 1_700_000_000,
      data: {
        object: {
          id: "pi_pix_meta_456",
          metadata: { cartId, customerId: "cus_01" },
          last_payment_error: null,
        },
      },
    };
  }

  it("persists orderId through stripeAdjudicated.paymentIntents.update with event-keyed idempotency", async () => {
    const event = createPixEvent("evt_pix_meta_42", "cart_pix_42");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    // cart-complete returns an order so the metadata-persist branch fires
    mockMedusaAdjudicated.mockResolvedValue({
      type: "order",
      order: { id: "order_pix_42", display_id: 200 },
    });
    // capturePayment may run; we don't care about its output here.
    mockCapturePayment.mockResolvedValue(null);

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

    // The wrapper WAS called with the expected shape.
    expect(mockStripeAdjudicatedUpdate).toHaveBeenCalledTimes(1);
    const [piId, params, meta] = mockStripeAdjudicatedUpdate.mock.calls[0]!;
    expect(piId).toBe("pi_pix_meta_456");
    expect(params).toMatchObject({
      metadata: expect.objectContaining({
        cartId: "cart_pix_42",
        customerId: "cus_01",
        medusaOrderId: expect.stringMatching(/order|200/),
      }),
    });
    expect(meta).toMatchObject({
      sourceSubject: "webhook:stripe:evt_pix_meta_42",
      idempotencyKey: "evt_pix_meta_42:metadata-update:pi_pix_meta_456",
    });
  });

  it("does NOT call the bare Stripe SDK paymentIntents.update for metadata-persist (bypass-detection sentinel)", async () => {
    const event = createPixEvent("evt_pix_bare_check_01");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdjudicated.mockResolvedValue({
      type: "order",
      order: { id: "order_pix_99", display_id: 300 },
    });
    mockCapturePayment.mockResolvedValue(null);

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=valid",
      },
      payload: Buffer.from("{}"),
    });

    // The bare SDK update transport MUST stay dormant for this mutation.
    // If a future refactor reverts to `stripe.paymentIntents.update(...)`,
    // this assertion blocks it.
    expect(mockBareStripePaymentIntentsUpdate).not.toHaveBeenCalled();
    // And the wrapper IS called.
    expect(mockStripeAdjudicatedUpdate).toHaveBeenCalledTimes(1);
  });

  it("acks Stripe with 200 + swallows StripeAdjudicateRefusedError (no retry storm)", async () => {
    const event = createPixEvent("evt_pix_refuse_meta_01");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockMedusaAdjudicated.mockResolvedValue({
      type: "order",
      order: { id: "order_pix_refuse_01", display_id: 400 },
    });
    // Kernel refuses the metadata-persist (e.g. policy bundle change).
    mockStripeAdjudicatedUpdate.mockRejectedValue(
      new MockRefusedError({
        code: "stripe.kind.not_allowed",
        userFacing: "Operação Stripe não permitida no momento.",
      }),
    );

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

    // Governance-driven skip — Stripe still gets 200 so no retry storm.
    expect(res.statusCode).toBe(200);
    // Wrapper was attempted; bare SDK never touched.
    expect(mockStripeAdjudicatedUpdate).toHaveBeenCalledTimes(1);
    expect(mockBareStripePaymentIntentsUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — double-capture race (P0-PAY-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  afterEach(() => {
    // restore the default pass-through lock so other suites are unaffected
    lockState.impl = async (_key: string, fn: () => Promise<unknown>) => fn();
  });

  it("serializes two concurrent succeeded events for one order — single capture + single order.placed", async () => {
    // Two distinct succeeded events (distinct PaymentIntents) for the SAME order —
    // the realistic case after amend_order/regenerate_pix mints a 2nd PI.
    const evtA = createStripeEvent("payment_intent.succeeded", { id: "pi_a" }, "evt_a");
    const evtB = createStripeEvent("payment_intent.succeeded", { id: "pi_b" }, "evt_b");
    mockConstructEvent.mockReturnValueOnce(evtA).mockReturnValueOnce(evtB);

    // Distinct event ids → both pass the SET-NX idempotency gate.
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: vi.fn().mockResolvedValue("OK") }));
    mockPublishNatsEvent.mockResolvedValue(undefined);

    // Real try-lock matching production withLock: the loser gets null (no queue).
    const keysSeen: string[] = [];
    const held = new Set<string>();
    let active = 0;
    let maxConcurrent = 0;
    lockState.impl = async (key: string, fn: () => Promise<unknown>) => {
      keysSeen.push(key);
      if (held.has(key)) return null; // contention → loser short-circuits
      held.add(key);
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      try {
        return await fn();
      } finally {
        active--;
        held.delete(key);
      }
    };

    // capturePayment yields (so the second event hits the held lock); the lock
    // winner returns a result, a subsequent call returns null (metadata guard).
    let captureCalls = 0;
    mockCapturePayment.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      if (captureCalls++ === 0) {
        return {
          customerId: "cus_01", displayId: 1, customerEmail: "a@b.com",
          customerName: "T", customerPhone: "+5511", totalInCentavos: 8900,
          subtotalInCentavos: 8900, shippingInCentavos: 0, items: [],
          paymentMethod: "pix", deliveryType: "pickup", tipInCentavos: 0,
        };
      }
      return null;
    });

    const app = await buildTestServer();
    const fire = () =>
      app.inject({
        method: "POST",
        url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=x" },
        payload: Buffer.from("{}"),
      });

    const [r1, r2] = await Promise.all([fire(), fire()]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // Capture was wrapped in a per-order lock.
    expect(keysSeen).toContain("order-capture:order_01");
    // The lock never let capture run concurrently.
    expect(maxConcurrent).toBe(1);
    // Exactly one order.placed despite two succeeded events → no double capture.
    const placed = mockPublishNatsEvent.mock.calls.filter((c) => c[0] === "order.placed");
    expect(placed).toHaveLength(1);
  });
});

describe("POST /api/webhooks/stripe — livemode binding (P3-SEC-STRIPESRC)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv(); // STRIPE_SECRET_KEY = sk_test_123 → expectedLivemode = false
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
  });

  const liveEvent = (livemode: boolean, id: string) => ({
    id,
    type: "payment_intent.succeeded",
    created: 1_700_000_000,
    livemode,
    data: { object: { id: "pi_test_123", metadata: { medusaOrderId: "order_01" }, last_payment_error: null } },
  });

  const fire = async () => {
    const app = await buildTestServer();
    return app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=valid" },
      payload: Buffer.from("{}"),
    });
  };

  it("rejects a live-mode event under a test key — 400, no idempotency claim, no downstream", async () => {
    mockConstructEvent.mockReturnValue(liveEvent(true, "evt_live_1"));
    const setMock = vi.fn().mockResolvedValue("OK");
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: setMock }));

    const res = await fire();

    expect(res.statusCode).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
    expect(mockCapturePayment).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("accepts a test-mode event under a test key (modes match) — reaches processing", async () => {
    mockConstructEvent.mockReturnValue(liveEvent(false, "evt_test_match"));
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockCapturePayment.mockResolvedValue(null); // no-op cleanly past the gate

    const res = await fire();

    expect(res.statusCode).toBe(200);
    expect(mockCapturePayment).toHaveBeenCalled(); // proves it passed the livemode gate
  });

  it("rejects a test-mode event under a LIVE key (mismatch the other way) — 400, no claim", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_realkey"); // expectedLivemode = true
    mockConstructEvent.mockReturnValue(liveEvent(false, "evt_test_2"));
    const setMock = vi.fn().mockResolvedValue("OK");
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: setMock }));

    const res = await fire();

    expect(res.statusCode).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
    expect(mockCapturePayment).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — PIX cart-complete concurrency (PIXDUP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
  });

  afterEach(() => {
    // restore the default pass-through lock so other suites are unaffected
    lockState.impl = async (_key: string, fn: () => Promise<unknown>) => fn();
  });

  // PIX event: no medusaOrderId → triggers the cart-complete branch; cartId fixed.
  const pixEvent = (id: string) => ({
    id,
    type: "payment_intent.succeeded",
    created: 1_700_000_000,
    livemode: false,
    data: { object: { id: "pi_pixdup", metadata: { cartId: "cart_99" }, last_payment_error: null } },
  });

  const fire = (app: Awaited<ReturnType<typeof buildTestServer>>) =>
    app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=x" },
      payload: Buffer.from("{}"),
    });

  it("retries (500) and never issues a 2nd /complete when the cart-complete lock is held", async () => {
    lockState.impl = async (key: string, fn: () => Promise<unknown>) =>
      key.startsWith("cart-complete:") ? null : fn();
    mockConstructEvent.mockReturnValue(pixEvent("evt_pixdup_1"));
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: vi.fn().mockResolvedValue("OK") }));
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const res = await fire(await buildTestServer());

    expect(res.statusCode).toBe(500); // contention → outer catch → Stripe retry
    expect(mockMedusaAdjudicated).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "/store/carts/cart_99/complete" }),
    );
    expect(mockPublishNatsEvent.mock.calls.filter((c) => c[0] === "order.placed")).toHaveLength(0);
  });

  it("serializes two concurrent succeeded events for one cart — exactly one /complete", async () => {
    const keysSeen: string[] = [];
    const held = new Set<string>();
    let active = 0;
    let maxConcurrent = 0;
    lockState.impl = async (key: string, fn: () => Promise<unknown>) => {
      keysSeen.push(key);
      if (held.has(key)) return null;
      held.add(key);
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      try {
        return await fn();
      } finally {
        active--;
        held.delete(key);
      }
    };
    mockConstructEvent.mockReturnValueOnce(pixEvent("evt_pd_a")).mockReturnValueOnce(pixEvent("evt_pd_b"));
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: vi.fn().mockResolvedValue("OK") }));
    mockPublishNatsEvent.mockResolvedValue(undefined);
    let completeCalls = 0;
    mockMedusaAdjudicated.mockImplementation(async (opts: { path?: string }) => {
      if (opts.path === "/store/carts/cart_99/complete") {
        await new Promise((r) => setTimeout(r, 25));
        completeCalls++;
        return { type: "order", order: { id: "order_x", display_id: 7 } };
      }
      return {};
    });
    mockCapturePayment.mockResolvedValue(null);

    const app = await buildTestServer();
    await Promise.all([fire(app), fire(app)]);

    expect(keysSeen).toContain("cart-complete:cart_99");
    expect(maxConcurrent).toBe(1); // the lock never let two completions run at once
    expect(completeCalls).toBe(1); // loser never issued a 2nd /complete
  });
});

// ── T2-1 — paid-state path: reconcile orderId fallback + capture isolation ───
//
// The paid-state fixture (packages/journeys) drives PAID through this route.
// Two route-side behaviors make that kernel-routed path land:
//   1. reconcile PI-lookup fallback: when getByStripePaymentIntentId misses
//      AND the (signed) event's metadata.medusaOrderId resolved an order, the
//      order's ACTIVE payment is adopted — UNLESS it already carries a
//      DIFFERENT PI id (stale/foreign PI is never adopted). Production-real:
//      the PIX flow's order.placed subscriber races this reconcile, and the
//      metadata stamp is the SUT's own.
//   2. capture-leg isolation: a capture failure must not kill the job — the
//      route's idempotency key is already claimed (Stripe will not retry), so
//      losing the reconcile would permanently strand the PAID truth.

describe("POST /api/webhooks/stripe — reconcile orderId fallback (T2-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: vi.fn().mockResolvedValue("OK") }));
    mockPublishNatsEvent.mockResolvedValue(undefined);
    // PI lookup always misses in this suite.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
    // "Already processed" capture shape → handler proceeds straight to reconcile.
    mockCapturePayment.mockResolvedValue(null);
  });

  async function fire(eventId: string) {
    const event = createStripeEvent("payment_intent.succeeded", {}, eventId);
    mockConstructEvent.mockReturnValue(event);
    const app = await buildTestServer();
    return app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=valid" },
      payload: Buffer.from("{}"),
    });
  }

  it("adopts the order's active payment when it carries NO PI id (linkage absent)", async () => {
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_cash_01",
      orderId: "order_01",
      status: "cash_pending",
      method: "cash",
      stripePaymentIntentId: null,
      statusHistory: [],
    });
    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2 },
    });

    const res = await fire("evt_fallback_adopt_01");

    expect(res.statusCode).toBe(200);
    expect(mockGetActiveByOrderId).toHaveBeenCalledWith("order_01");
    expect(mockReconcileFromWebhookFromEnvelope).toHaveBeenCalledTimes(1);
    const envelope = mockReconcileFromWebhookFromEnvelope.mock.calls[0]?.[0];
    expect(envelope).toMatchObject({
      kind: "payment.status.reconcile",
      actor: { principal: "system", sessionId: "stripe-webhook:evt_fallback_adopt_01" },
      taint: "SYSTEM",
      payload: {
        paymentId: "pay_cash_01",
        newStatus: "paid",
        expectedOrderId: "order_01",
      },
    });
    // The kernel-approved reconcile publishes the paid transition.
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({ paymentId: "pay_cash_01", newStatus: "paid" }),
    );
  });

  it("adopts when the active payment carries the SAME PI id", async () => {
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_pix_01",
      orderId: "order_01",
      status: "awaiting_payment",
      method: "pix",
      stripePaymentIntentId: "pi_test_123", // = the event's PI
      statusHistory: [],
    });
    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2 },
    });

    const res = await fire("evt_fallback_same_pi_01");

    expect(res.statusCode).toBe(200);
    expect(mockReconcileFromWebhookFromEnvelope).toHaveBeenCalledTimes(1);
    expect(mockReconcileFromWebhookFromEnvelope.mock.calls[0]?.[0]?.payload?.paymentId).toBe(
      "pay_pix_01",
    );
  });

  it("NEVER adopts a payment that carries a DIFFERENT PI id (stale/foreign PI)", async () => {
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_other_01",
      orderId: "order_01",
      status: "awaiting_payment",
      method: "pix",
      stripePaymentIntentId: "pi_DIFFERENT_999",
      statusHistory: [],
    });

    const res = await fire("evt_fallback_foreign_01");

    expect(res.statusCode).toBe(200); // skip is logged, never a retry storm
    expect(mockReconcileFromWebhookFromEnvelope).not.toHaveBeenCalled();
  });

  it("payment_intent.payment_failed has NO fallback (only the succeeded handler resolves an orderId)", async () => {
    const event = createStripeEvent("payment_intent.payment_failed", {}, "evt_no_fallback_01");
    mockConstructEvent.mockReturnValue(event);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=valid" },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    expect(mockGetActiveByOrderId).not.toHaveBeenCalled();
    expect(mockReconcileFromWebhookFromEnvelope).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — capture-leg failure isolation (T2-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetAuditSinkEmit.mockResolvedValue(undefined);
    mockGetRedisClient.mockResolvedValue(createMockRedis({ set: vi.fn().mockResolvedValue("OK") }));
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockGetActiveByOrderId.mockResolvedValue(null);
  });

  it("a capturePayment throw no longer kills the job — the reconcile still runs", async () => {
    mockCapturePayment.mockRejectedValue(new Error("Medusa 404: dead v1 capture endpoint"));
    mockGetByStripePaymentIntentId.mockResolvedValue({
      id: "pay_01",
      orderId: "order_01",
      status: "awaiting_payment",
      method: "pix",
    });
    mockReconcileFromWebhookFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2 },
    });

    const event = createStripeEvent("payment_intent.succeeded", {}, "evt_capture_iso_01");
    mockConstructEvent.mockReturnValue(event);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=valid" },
      payload: Buffer.from("{}"),
    });

    expect(res.statusCode).toBe(200);
    // PAID truth landed despite the capture failure.
    expect(mockReconcileFromWebhookFromEnvelope).toHaveBeenCalledTimes(1);
    expect(mockReconcileFromWebhookFromEnvelope.mock.calls[0]?.[0]?.payload?.newStatus).toBe(
      "paid",
    );
    // order.placed is NOT published off a failed capture.
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith("order.placed", expect.anything());
  });
});

describe("stripeWebhookRoutes — worker gate prod-parity (T2-1 / D-014 class)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
  });

  it("does NOT start the processor under plain NODE_ENV=test (unit-test env)", async () => {
    // vitest sets NODE_ENV=test and no fingerprint is stubbed.
    await buildTestServer();
    expect(mockStartStripeWebhookProcessor).not.toHaveBeenCalled();
  });

  it("starts the processor when IBX_TEST_FINGERPRINT is set (journey test stack)", async () => {
    vi.stubEnv("IBX_TEST_FINGERPRINT", "ibx-test-unit");
    await buildTestServer();
    expect(mockStartStripeWebhookProcessor).toHaveBeenCalledTimes(1);
  });
});
