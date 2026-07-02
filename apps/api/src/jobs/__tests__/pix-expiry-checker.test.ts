// Unit tests for the PIX expiry checker job (Payment-aware version).
// Calls checkPixExpiry() directly — no BullMQ, no network, no DB.
//
// INVARIANT UNDER TEST: This job NEVER cancels orders.
// It only transitions payment status to payment_expired.
//
// Mocks: @ibatexas/domain (prisma, createPaymentCommandService),
//        @ibatexas/tools (withLock, cancelStalePaymentIntent),
//        @ibatexas/nats-client (publishNatsEvent),
//        @sentry/node, ./queue.js (BullMQ factories).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkPixExpiry,
  startPixExpiryChecker,
  stopPixExpiryChecker,
} from "../pix-expiry-checker.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockTransitionStatus = vi.hoisted(() => vi.fn());
const mockPaymentFindMany = vi.hoisted(() => vi.fn());
const mockWithLock = vi.hoisted(() => vi.fn());
const mockCancelStalePaymentIntent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockSentryWithScope = vi.hoisted(() => vi.fn());
const mockSentryCaptureException = vi.hoisted(() => vi.fn());

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    payment: {
      findMany: mockPaymentFindMany,
    },
  },
  createPaymentCommandService: vi.fn(() => ({
    transitionStatus: mockTransitionStatus,
    // Task 16: envelope-typed entry — wraps the legacy mock so existing
    // assertions on `mockTransitionStatus` still fire and existing tests
    // don't need to change their assertions.
    transitionStatusFromEnvelope: vi.fn(async (envelope: { payload: { paymentId: string; newStatus: string; expectedVersion?: number; actor: string; reason?: string } }) => {
      const result = await mockTransitionStatus(envelope.payload.paymentId, {
        newStatus: envelope.payload.newStatus,
        actor: envelope.payload.actor,
        ...(envelope.payload.reason !== undefined ? { reason: envelope.payload.reason } : {}),
        ...(envelope.payload.expectedVersion !== undefined ? { expectedVersion: envelope.payload.expectedVersion } : {}),
      });
      return { decision: { kind: "EXECUTE", basis: [] }, result };
    }),
  })),
}));

vi.mock("@ibatexas/tools", () => ({
  withLock: mockWithLock,
  cancelStalePaymentIntent: mockCancelStalePaymentIntent,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@sentry/node", () => ({
  withScope: mockSentryWithScope,
  captureException: mockSentryCaptureException,
  init: vi.fn(),
}));

vi.mock("../queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: "info",
  } as unknown as import("fastify").FastifyBaseLogger;
}

function makeExpiredPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_01",
    orderId: "order_01",
    stripePaymentIntentId: "pi_test_123",
    version: 1,
    ...overrides,
  };
}

/** withLock mock that immediately invokes the callback (lock acquired). */
function withLockExecutes() {
  mockWithLock.mockImplementation(
    async (_resource: string, fn: () => Promise<unknown>, _ttl?: number) => fn(),
  );
}

/** withLock mock that returns null (lock contended — not acquired). */
function withLockContended() {
  mockWithLock.mockResolvedValue(null);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkPixExpiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default Sentry: invoke scope callback so captureException fires
    mockSentryWithScope.mockImplementation((cb: (scope: unknown) => void) => {
      cb({ setTag: vi.fn(), setContext: vi.fn() });
    });
  });

  afterEach(async () => {
    await stopPixExpiryChecker();
  });

  // ── Core happy path ───────────────────────────────────────────────────────

  it("acquires lock, transitions payment to payment_expired, cancels Stripe PI, publishes NATS event", async () => {
    const payment = makeExpiredPayment();
    mockPaymentFindMany.mockResolvedValue([payment]);
    withLockExecutes();
    mockTransitionStatus.mockResolvedValue({
      previousStatus: "payment_pending",
      newStatus: "payment_expired",
      version: 2,
    });
    mockCancelStalePaymentIntent.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkPixExpiry();

    // Lock acquired on the correct resource
    expect(mockWithLock).toHaveBeenCalledWith(
      `payment:${payment.id}`,
      expect.any(Function),
      10,
    );

    // Payment transitioned to payment_expired
    expect(mockTransitionStatus).toHaveBeenCalledWith(payment.id, {
      newStatus: "payment_expired",
      actor: "system",
      reason: "PIX expirado",
      expectedVersion: payment.version,
    });

    // Stripe PI cancelled
    expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith(payment.stripePaymentIntentId);

    // NATS event published with short-form subject
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({
        eventType: "payment.status_changed",
        orderId: payment.orderId,
        paymentId: payment.id,
        previousStatus: "payment_pending",
        newStatus: "payment_expired",
        method: "pix",
      }),
    );
  });

  // ── INVARIANT: orders are NEVER touched ──────────────────────────────────

  it("never calls any order cancellation — order is not touched", async () => {
    const payment = makeExpiredPayment();
    mockPaymentFindMany.mockResolvedValue([payment]);
    withLockExecutes();
    mockTransitionStatus.mockResolvedValue({
      previousStatus: "payment_pending",
      newStatus: "payment_expired",
      version: 2,
    });
    mockCancelStalePaymentIntent.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkPixExpiry();

    // No domain service with order mutation should ever be called
    // The mock registry only contains payment-level mocks — assert no order calls leak through
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      expect.stringContaining("order"),
      expect.anything(),
    );
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "order.cancelled",
      expect.anything(),
    );
  });

  // ── No Stripe PI — skips cancel, still transitions and publishes ──────────

  it("skips Stripe PI cancellation when stripePaymentIntentId is null", async () => {
    const payment = makeExpiredPayment({ stripePaymentIntentId: null });
    mockPaymentFindMany.mockResolvedValue([payment]);
    withLockExecutes();
    mockTransitionStatus.mockResolvedValue({
      previousStatus: "payment_pending",
      newStatus: "payment_expired",
      version: 2,
    });
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkPixExpiry();

    expect(mockCancelStalePaymentIntent).not.toHaveBeenCalled();
    expect(mockTransitionStatus).toHaveBeenCalledTimes(1);
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
  });

  // ── Stripe PI cancel fails — continues, still publishes NATS event ────────

  it("continues and publishes NATS event when Stripe PI cancellation throws", async () => {
    const payment = makeExpiredPayment();
    mockPaymentFindMany.mockResolvedValue([payment]);
    withLockExecutes();
    mockTransitionStatus.mockResolvedValue({
      previousStatus: "payment_pending",
      newStatus: "payment_expired",
      version: 2,
    });
    mockCancelStalePaymentIntent.mockRejectedValue(new Error("Stripe 409: already canceled"));
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const log = buildMockLogger();
    await checkPixExpiry(log);

    // Warn logged for PI failure
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: payment.id }),
      "[pix-expiry] Failed to cancel Stripe PI — continuing",
    );

    // NATS event still published
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
  });

  // ── Lock not acquired — skips payment ────────────────────────────────────

  it("skips payment when lock is not acquired (contended)", async () => {
    const payment = makeExpiredPayment();
    mockPaymentFindMany.mockResolvedValue([payment]);
    withLockContended();

    const log = buildMockLogger();
    await checkPixExpiry(log);

    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockCancelStalePaymentIntent).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();

    // NOISE-4: contention skip demoted to debug + tagged.
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ component: "job.pix-expiry", event: "lock_skip", paymentId: payment.id }),
      "[pix-expiry] Lock not acquired — skipping (will retry next run)",
    );
  });

  // ── InvalidPaymentTransitionError — already transitioned, skip silently ───

  it("skips payment when transitionStatus throws InvalidPaymentTransitionError", async () => {
    const payment = makeExpiredPayment();
    mockPaymentFindMany.mockResolvedValue([payment]);
    withLockExecutes();

    const err = new Error("invalid transition");
    err.name = "InvalidPaymentTransitionError";
    mockTransitionStatus.mockRejectedValue(err);

    const log = buildMockLogger();
    await checkPixExpiry(log);

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    expect(mockCancelStalePaymentIntent).not.toHaveBeenCalled();

    // NOISE-4: already-transitioned skip demoted to debug + tagged.
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ component: "job.pix-expiry", event: "already_transitioned", paymentId: payment.id }),
      "[pix-expiry] Payment already transitioned — skipping",
    );
  });

  // ── PaymentConcurrencyError — version changed, retry next run ─────────────

  it("skips payment when transitionStatus throws PaymentConcurrencyError", async () => {
    const payment = makeExpiredPayment();
    mockPaymentFindMany.mockResolvedValue([payment]);
    withLockExecutes();

    const err = new Error("version mismatch");
    err.name = "PaymentConcurrencyError";
    mockTransitionStatus.mockRejectedValue(err);

    const log = buildMockLogger();
    await checkPixExpiry(log);

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();

    // NOISE-4: concurrency-conflict skip demoted to debug + tagged.
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ component: "job.pix-expiry", event: "concurrency_conflict", paymentId: payment.id }),
      "[pix-expiry] Concurrency conflict — will retry next run",
    );
  });

  // ── Query filters: only payment_pending PIX payments ─────────────────────

  it("queries only pix method + payment_pending + pixExpiresAt < now", async () => {
    mockPaymentFindMany.mockResolvedValue([]);

    await checkPixExpiry();

    expect(mockPaymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          method: "pix",
          status: "payment_pending",
          pixExpiresAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    );
  });

  // ── No expired payments — nothing processed ───────────────────────────────

  it("does nothing when no expired payments are found", async () => {
    mockPaymentFindMany.mockResolvedValue([]);

    await checkPixExpiry();

    expect(mockWithLock).not.toHaveBeenCalled();
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockCancelStalePaymentIntent).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Multiple payments — all processed ────────────────────────────────────

  it("processes all expired payments in the batch", async () => {
    const payments = [
      makeExpiredPayment({ id: "pay_a", orderId: "order_a", stripePaymentIntentId: "pi_a" }),
      makeExpiredPayment({ id: "pay_b", orderId: "order_b", stripePaymentIntentId: "pi_b" }),
      makeExpiredPayment({ id: "pay_c", orderId: "order_c", stripePaymentIntentId: "pi_c" }),
    ];
    mockPaymentFindMany.mockResolvedValue(payments);
    withLockExecutes();
    mockTransitionStatus.mockResolvedValue({
      previousStatus: "payment_pending",
      newStatus: "payment_expired",
      version: 2,
    });
    mockCancelStalePaymentIntent.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkPixExpiry();

    expect(mockTransitionStatus).toHaveBeenCalledTimes(3);
    expect(mockCancelStalePaymentIntent).toHaveBeenCalledTimes(3);
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
  });

  // ── Error per payment — continues processing remaining ────────────────────

  it("continues processing remaining payments when one throws an unexpected error", async () => {
    const payments = [
      makeExpiredPayment({ id: "pay_fail", orderId: "order_fail" }),
      makeExpiredPayment({ id: "pay_ok", orderId: "order_ok" }),
    ];
    mockPaymentFindMany.mockResolvedValue(payments);
    withLockExecutes();

    mockTransitionStatus
      .mockRejectedValueOnce(new Error("Unexpected DB error"))
      .mockResolvedValueOnce({
        previousStatus: "payment_pending",
        newStatus: "payment_expired",
        version: 2,
      });
    mockCancelStalePaymentIntent.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const log = buildMockLogger();
    await checkPixExpiry(log);

    // Sentry notified for the failing payment
    expect(mockSentryWithScope).toHaveBeenCalled();
    expect(mockSentryCaptureException).toHaveBeenCalled();

    // Second payment still published
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({ orderId: "order_ok" }),
    );
  });

  // ── Top-level query failure — Sentry notified ─────────────────────────────

  it("captures Sentry exception when the payment query fails", async () => {
    mockPaymentFindMany.mockRejectedValue(new Error("DB connection lost"));

    const log = buildMockLogger();
    await checkPixExpiry(log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("DB connection lost") }),
      "[pix-expiry] Error querying expired payments",
    );
    expect(mockSentryWithScope).toHaveBeenCalled();
    expect(mockSentryCaptureException).toHaveBeenCalled();
  });

  // ── Completion log ────────────────────────────────────────────────────────

  it("logs completion summary with expired_count after run", async () => {
    const payment = makeExpiredPayment();
    mockPaymentFindMany.mockResolvedValue([payment]);
    withLockExecutes();
    mockTransitionStatus.mockResolvedValue({
      previousStatus: "payment_pending",
      newStatus: "payment_expired",
      version: 2,
    });
    mockCancelStalePaymentIntent.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const log = buildMockLogger();
    await checkPixExpiry(log);

    // NOISE-4: summary logs only when payments expired, tagged component/event.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "job.pix-expiry", event: "sweep", expired_count: 1 }),
      "PIX expiry sweep expired payments",
    );
  });

  it("does NOT log a sweep summary when no payments expired", async () => {
    mockPaymentFindMany.mockResolvedValue([]);

    const log = buildMockLogger();
    await checkPixExpiry(log);

    // NOISE-4: an idle sweep (expired_count 0) is silent — no heartbeat line.
    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "PIX expiry sweep expired payments",
    );
  });

  // ── Lifecycle: start / stop ───────────────────────────────────────────────

  it("startPixExpiryChecker starts without throwing", () => {
    expect(() => startPixExpiryChecker()).not.toThrow();
  });

  it("stopPixExpiryChecker resolves when not started", async () => {
    await expect(stopPixExpiryChecker()).resolves.toBeUndefined();
  });
});
