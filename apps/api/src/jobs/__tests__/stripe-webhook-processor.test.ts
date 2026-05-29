// Unit tests for the DURABLE Stripe webhook processor (P1-NET-STRIPESYNC).
//
// The route (POST /api/webhooks/stripe) now verifies + claims-idempotency + ENQUEUES
// and returns 200 fast. This processor does the heavy work asynchronously with
// durable BullMQ retry. These tests cover:
//   - processStripeEvent does the heavy work (Medusa-complete / capture / NATS /
//     reconcile) that used to run on the response path
//   - a FAILED processing throws so the BullMQ job RETRIES (not lost / not stranded)
//   - the per-order capture lock still serializes double-capture (P0-PAY-2)
//   - enqueue uses durable retry config (attempts + exponential backoff) + jobId dedup
//   - the worker attaches a "failed" listener (observability for exhausted retries)
//
// No BullMQ/Redis/network — ./queue.js and all externals are mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `test:${k}`));
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockCapturePayment = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockMarkPixPaid = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReconcileFromWebhook = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "pay_01", version: 2 }));
const mockGetByPi = vi.hoisted(() => vi.fn().mockResolvedValue(null));

// Swappable withLock — defaults to pass-through; the double-capture test installs
// a real try-lock matching production semantics (loser gets null).
const lockState = vi.hoisted(() => ({
  impl: async (_key: string, fn: () => Promise<unknown>): Promise<unknown> => fn(),
}));

// Records jobs added + listeners attached by the worker.
const queueAdd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const workerListeners = vi.hoisted(() => new Map<string, (...a: unknown[]) => void>());
const mockCreateWorker = vi.hoisted(() =>
  vi.fn(() => ({
    on: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
      workerListeners.set(event, handler);
    }),
    close: vi.fn(),
  })),
);
const mockCreateQueue = vi.hoisted(() => vi.fn(() => ({ add: queueAdd, close: vi.fn() })));

const mockCaptureException = vi.hoisted(() => vi.fn());
const mockWithScope = vi.hoisted(() =>
  vi.fn((cb: (s: { setTag: () => void; setContext: () => void }) => void) =>
    cb({ setTag: vi.fn(), setContext: vi.fn() }),
  ),
);

// ── Module mocks (before imports) ──────────────────────────────────────────────
vi.mock("stripe", () => ({
  default: class MockStripe {
    paymentIntents = { update: vi.fn().mockResolvedValue({}) };
  },
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  medusaAdmin: mockMedusaAdmin,
  medusaStore: mockMedusaStore,
  withLock: vi.fn((key: string, fn: () => Promise<unknown>) => lockState.impl(key, fn)),
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderService: () => ({ capturePayment: mockCapturePayment }),
  createPaymentCommandService: () => ({ reconcileFromWebhook: mockReconcileFromWebhook }),
  createPaymentQueryService: () => ({ getByStripePaymentIntentId: mockGetByPi }),
  createOrderEventLogService: () => ({ append: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../pix-expiry-monitor.js", () => ({
  markPixPaid: mockMarkPixPaid,
}));

vi.mock("../queue.js", () => ({
  createQueue: mockCreateQueue,
  createWorker: mockCreateWorker,
}));

vi.mock("@sentry/node", () => ({
  withScope: mockWithScope,
  captureException: mockCaptureException,
}));

vi.mock("../../lib/logger.js", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  processStripeEvent,
  enqueueStripeWebhookEvent,
  startStripeWebhookProcessor,
  stopStripeWebhookProcessor,
  type StripeWebhookJobData,
} from "../stripe-webhook-processor.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    expire: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function succeededEvent(pi: Record<string, unknown> = {}, id = "evt_1") {
  return {
    id,
    type: "payment_intent.succeeded",
    created: 1_700_000_000,
    data: {
      object: {
        id: "pi_1",
        amount: 8900, // centavos
        metadata: { medusaOrderId: "order_01" },
        last_payment_error: null,
        ...pi,
      },
    },
  } as unknown as StripeWebhookJobData["event"];
}

const captureResult = {
  customerId: "cus_01",
  displayId: 42,
  customerEmail: "a@b.com",
  customerName: "Test",
  customerPhone: "+5511",
  totalInCentavos: 8900,
  subtotalInCentavos: 8900,
  shippingInCentavos: 0,
  items: [{ productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 8900, title: "Costela" }],
  paymentMethod: "pix",
  deliveryType: "pickup",
  tipInCentavos: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
  mockRk.mockImplementation((k: string) => `test:${k}`);
  mockGetRedisClient.mockResolvedValue(createMockRedis());
  mockGetByPi.mockResolvedValue(null);
  lockState.impl = async (_key: string, fn: () => Promise<unknown>) => fn();
  workerListeners.clear();
});

afterEach(async () => {
  await stopStripeWebhookProcessor();
  vi.unstubAllEnvs();
});

// ── processStripeEvent: heavy work ─────────────────────────────────────────────

describe("processStripeEvent — payment_intent.succeeded (heavy work moved off response path)", () => {
  it("captures payment (centavos amount) under a per-order lock and publishes order.placed", async () => {
    mockCapturePayment.mockResolvedValueOnce(captureResult);

    const keysSeen: string[] = [];
    lockState.impl = async (key: string, fn: () => Promise<unknown>) => {
      keysSeen.push(key);
      return fn();
    };

    await processStripeEvent({ event: succeededEvent(), receivedAtMs: Date.now() }, log);

    // Capture wrapped in the per-order lock, with the centavos amount (off-by-100 fix).
    expect(keysSeen).toContain("order-capture:order_01");
    expect(mockCapturePayment).toHaveBeenCalledWith(
      "order_01",
      "pi_1",
      { amountInCentavos: 8900 },
    );
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.placed",
      expect.objectContaining({ eventType: "order.placed", orderId: "order_01" }),
    );
  });

  it("completes the PIX cart when only cartId is present (no medusaOrderId)", async () => {
    mockMedusaStore.mockResolvedValueOnce({ order: { id: "order_pix", display_id: 7 } });
    mockCapturePayment.mockResolvedValueOnce(captureResult);

    await processStripeEvent(
      { event: succeededEvent({ metadata: { cartId: "cart_99" } }), receivedAtMs: Date.now() },
      log,
    );

    expect(mockMedusaStore).toHaveBeenCalledWith("/store/carts/cart_99/complete", expect.anything());
    expect(mockCapturePayment).toHaveBeenCalled();
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("order.placed", expect.anything());
  });
});

// ── The durability invariant: failure RETRIES, never strands the order ──────────

describe("processStripeEvent — failures are retryable (durable path, P1-NET-STRIPESYNC)", () => {
  it("THROWS when PIX cart-complete fails so the BullMQ job retries (order not stranded)", async () => {
    // Previously this error was swallowed and the route still returned 200, which —
    // with the idempotency key claimed — would strand the order. Now it must throw.
    mockMedusaStore.mockRejectedValueOnce(new Error("Medusa cart-complete timeout"));

    await expect(
      processStripeEvent(
        { event: succeededEvent({ metadata: { cartId: "cart_99" } }), receivedAtMs: Date.now() },
        log,
      ),
    ).rejects.toThrow("Medusa cart-complete timeout");

    // No order.placed published on the failed attempt — it will be retried.
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith("order.placed", expect.anything());
  });

  it("THROWS when capturePayment fails so the BullMQ job retries", async () => {
    mockCapturePayment.mockRejectedValueOnce(new Error("Medusa down"));

    await expect(
      processStripeEvent({ event: succeededEvent(), receivedAtMs: Date.now() }, log),
    ).rejects.toThrow("Medusa down");
  });

  it("THROWS when order.placed NATS publish fails so the BullMQ job retries", async () => {
    mockCapturePayment.mockResolvedValueOnce(captureResult);
    mockPublishNatsEvent.mockRejectedValueOnce(new Error("NATS unavailable"));

    await expect(
      processStripeEvent({ event: succeededEvent(), receivedAtMs: Date.now() }, log),
    ).rejects.toThrow("NATS unavailable");
  });
});

// ── Double-capture race (moved from the route test — P0-PAY-2) ──────────────────

describe("processStripeEvent — double-capture race (P0-PAY-2)", () => {
  it("serializes two concurrent succeeded events for one order — single capture + single order.placed", async () => {
    // Real try-lock matching production withLock: the loser gets null (no queue).
    const held = new Set<string>();
    let active = 0;
    let maxConcurrent = 0;
    lockState.impl = async (key: string, fn: () => Promise<unknown>) => {
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

    // Capture yields so the second event hits the held lock; winner returns a
    // result, the loser path (or a re-run) returns null via the metadata guard.
    let captureCalls = 0;
    mockCapturePayment.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return captureCalls++ === 0 ? captureResult : null;
    });

    await Promise.all([
      processStripeEvent({ event: succeededEvent({ id: "pi_a" }, "evt_a"), receivedAtMs: Date.now() }, log),
      processStripeEvent({ event: succeededEvent({ id: "pi_b" }, "evt_b"), receivedAtMs: Date.now() }, log),
    ]);

    // Lock never let capture run concurrently.
    expect(maxConcurrent).toBe(1);
    // Exactly one order.placed despite two succeeded events → no double capture.
    const placed = mockPublishNatsEvent.mock.calls.filter((c) => c[0] === "order.placed");
    expect(placed).toHaveLength(1);
  });
});

// ── Enqueue: durable retry config ──────────────────────────────────────────────

describe("enqueueStripeWebhookEvent — durable retry config", () => {
  it("adds a job with attempts + exponential backoff, jobId dedup, and starts the worker", async () => {
    const event = succeededEvent({}, "evt_enqueue");
    await enqueueStripeWebhookEvent(event, 12345);

    expect(mockCreateWorker).toHaveBeenCalledWith("stripe-webhook", expect.any(Function));
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queueAdd.mock.calls[0];
    expect(name).toBe("payment_intent.succeeded");
    expect(data).toMatchObject({ event: { id: "evt_enqueue" }, receivedAtMs: 12345 });
    // Durable retry: a transient failure is retried before the job is parked.
    expect(opts).toMatchObject({
      jobId: "evt_enqueue", // BullMQ-level dedup on the Stripe event id
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
    });
    // Failed jobs are RETAINED (no removeOnFail) for observability + replay.
    expect(opts.removeOnFail).toBeUndefined();
  });

  it("honors STRIPE_WEBHOOK_JOB_ATTEMPTS / _BACKOFF_MS env overrides", async () => {
    vi.resetModules();
    vi.stubEnv("STRIPE_WEBHOOK_JOB_ATTEMPTS", "9");
    vi.stubEnv("STRIPE_WEBHOOK_JOB_BACKOFF_MS", "1000");
    const mod = await import("../stripe-webhook-processor.js");

    await mod.enqueueStripeWebhookEvent(succeededEvent({}, "evt_env"), 1);
    const opts = queueAdd.mock.calls.at(-1)![2];
    expect(opts).toMatchObject({ attempts: 9, backoff: { type: "exponential", delay: 1000 } });

    await mod.stopStripeWebhookProcessor();
  });
});

// ── Worker observability ────────────────────────────────────────────────────────

describe("startStripeWebhookProcessor — worker wiring", () => {
  it("attaches a 'failed' listener that logs + reports to Sentry without throwing", () => {
    startStripeWebhookProcessor();

    expect(mockCreateWorker).toHaveBeenCalledWith("stripe-webhook", expect.any(Function));
    expect(workerListeners.has("failed")).toBe(true);

    const onFailed = workerListeners.get("failed")!;
    const err = new Error("attempts exhausted");
    expect(() =>
      onFailed({ data: { event: { id: "evt_x", type: "payment_intent.succeeded" } }, attemptsMade: 5 }, err),
    ).not.toThrow();
    expect(mockCaptureException).toHaveBeenCalledWith(err);
  });

  it("is idempotent — repeated starts create the worker once", () => {
    startStripeWebhookProcessor();
    startStripeWebhookProcessor();
    startStripeWebhookProcessor();
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });
});
