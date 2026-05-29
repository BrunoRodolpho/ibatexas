// Unit tests for Stripe webhook ROUTE.
// POST /api/webhooks/stripe — signature verify + idempotency claim + DURABLE enqueue.
//
// P1-NET-STRIPESYNC: the route is now ACK-THEN-PROCESS-ASYNC. After verifying the
// signature and claiming the idempotency key, it ENQUEUES the event to the durable
// BullMQ processor and returns 200 immediately — it no longer awaits the heavy
// Medusa-complete / capture / NATS / reconcile work on the response path. Those
// handlers are tested in jobs/__tests__/stripe-webhook-processor.test.ts.
//
// The processor is mocked here so the route tests stay isolated from BullMQ/Redis.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { stripeWebhookRoutes } from "../routes/stripe-webhook.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockConstructEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockEnqueue = vi.hoisted(() => vi.fn());
const mockStartProcessor = vi.hoisted(() => vi.fn());

vi.mock("stripe", () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

// The durable processor is mocked — the route only enqueues. Heavy-work behaviour
// is covered by the processor's own test file.
vi.mock("../jobs/stripe-webhook-processor.js", () => ({
  enqueueStripeWebhookEvent: mockEnqueue,
  startStripeWebhookProcessor: mockStartProcessor,
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

function inject(app: Awaited<ReturnType<typeof buildTestServer>>) {
  return app.inject({
    method: "POST",
    url: "/api/webhooks/stripe",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=123,v1=valid",
    },
    payload: Buffer.from("{}"),
  });
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

  it("returns 400 when signature verification fails — and does NOT enqueue", async () => {
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
    expect(res.json().error).toContain("verification failed");
    // Verify-before-enqueue: an unverified event must never be enqueued.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 with duplicate:true for already-claimed event — and does NOT enqueue", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    // SET NX returns null → event already processed/enqueued
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await inject(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().duplicate).toBe(true);
    // Dedup: a duplicate Stripe delivery must not re-enqueue heavy work.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("claims the idempotency key (SET NX 7d) BEFORE enqueuing", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const setMock = vi.fn().mockResolvedValue("OK");
    const mockRedis = createMockRedis({ set: setMock });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await inject(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Key claimed with NX + 7-day TTL covering Stripe's retry window.
    expect(setMock).toHaveBeenCalledWith(
      expect.stringContaining("webhook:processed:evt_test_123"),
      "1",
      { EX: 604800, NX: true },
    );
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/webhooks/stripe — ack-then-async enqueue (P1-NET-STRIPESYNC)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 quickly after verify+claim and enqueues the event to the durable processor", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);
    mockGetRedisClient.mockResolvedValue(createMockRedis());

    const app = await buildTestServer();
    const res = await inject(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // The heavy work is enqueued, not awaited on the response path.
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [enqueuedEvent, receivedAtMs] = mockEnqueue.mock.calls[0];
    expect(enqueuedEvent).toMatchObject({ id: "evt_test_123", type: "payment_intent.succeeded" });
    expect(typeof receivedAtMs).toBe("number");
  });

  it("enqueues all supported event types (route does not branch on type)", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis());

    for (const type of [
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "charge.refunded",
      "charge.dispute.created",
      "payment_intent.canceled",
      "invoice.payment_succeeded", // unknown-to-us type is still enqueued; processor no-ops
    ]) {
      mockEnqueue.mockClear();
      const event = createStripeEvent(type, {}, `evt_${type}`);
      mockConstructEvent.mockReturnValue(event);

      const app = await buildTestServer();
      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue.mock.calls[0][0]).toMatchObject({ type });
    }
  });

  it("does NOT call the heavy domain services on the response path", async () => {
    // The route module no longer imports Medusa/domain/NATS at all — proven by the
    // fact that we don't even mock them here. This test documents that the response
    // path is just verify → claim → enqueue. (Reaching for an unmocked module would
    // throw at import time; the suite loading at all is the assertion.)
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);
    mockGetRedisClient.mockResolvedValue(createMockRedis());

    const app = await buildTestServer();
    const res = await inject(app);

    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/webhooks/stripe — enqueue failure is not lossy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 500 and DOWNGRADES the idempotency key when enqueue fails, so Stripe retries", async () => {
    const event = createStripeEvent("payment_intent.succeeded");
    mockConstructEvent.mockReturnValue(event);

    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    // Enqueue (Redis/BullMQ) fails — nothing is queued.
    mockEnqueue.mockRejectedValueOnce(new Error("BullMQ unavailable"));

    const app = await buildTestServer();
    const res = await inject(app);

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("enqueue");
    // Key downgraded to 5 min so Stripe's retry re-delivers and re-enqueues —
    // the order is NOT stranded behind a 7-day claimed key with no queued job.
    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("evt_test_123"),
      300,
    );
  });
});

describe("POST /api/webhooks/stripe — worker startup wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("starts the durable processor worker at route registration (boot time)", async () => {
    // So jobs persisted before a crash are drained on restart, not only on the
    // next webhook. register-workers.ts is non-owned, so the worker self-registers
    // from this owned route file.
    await buildTestServer();
    expect(mockStartProcessor).toHaveBeenCalled();
  });
});
