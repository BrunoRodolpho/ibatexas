// Unit tests for the PIX expiry checker job
// Calls checkPixExpiry() directly — no BullMQ, no network, no DB.
// Mocks: @ibatexas/tools (medusaAdmin), @ibatexas/nats-client (publishNatsEvent),
//        @sentry/node (captureException), ./jobs/queue.js (BullMQ factories).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkPixExpiry,
  startPixExpiryChecker,
  stopPixExpiryChecker,
} from "../jobs/pix-expiry-checker.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockSentryCaptureException = vi.hoisted(() => vi.fn());
const mockSentryWithScope = vi.hoisted(() => vi.fn());

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return {
    medusaAdmin: mockMedusaAdmin,
    MedusaRequestError: actual.MedusaRequestError,
  };
});

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@sentry/node", () => ({
  captureException: mockSentryCaptureException,
  withScope: mockSentryWithScope,
  init: vi.fn(),
}));

vi.mock("../jobs/queue.js", () => ({
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

const PIX_EXPIRY_MINUTES = 30;

/** ISO timestamp older than the expiry window */
function expiredTimestamp(extraMs = 0): string {
  const expiryMs = PIX_EXPIRY_MINUTES * 60 * 1000;
  return new Date(Date.now() - expiryMs - extraMs - 1000).toISOString();
}

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkPixExpiry", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, PIX_EXPIRY_MINUTES: String(PIX_EXPIRY_MINUTES) };

    // Default: withScope invokes the callback so Sentry.captureException fires
    mockSentryWithScope.mockImplementation((cb: (scope: unknown) => void) => {
      cb({ setTag: vi.fn(), setContext: vi.fn() });
    });
  });

  afterEach(async () => {
    await stopPixExpiryChecker();
    process.env = originalEnv;
  });

  // ── Cancel expired orders ─────────────────────────────────────────────────

  it("cancels orders older than PIX_EXPIRY_MINUTES", async () => {
    const orderId = "order_expired_01";

    // First call: list pending orders (returns one expired order)
    mockMedusaAdmin.mockResolvedValueOnce({
      orders: [
        {
          id: orderId,
          status: "pending",
          created_at: expiredTimestamp(),
          metadata: { customerId: "cus_01" },
        },
      ],
    });
    // Second call: cancel that order
    mockMedusaAdmin.mockResolvedValueOnce({});
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkPixExpiry();

    // Cancel endpoint called for the expired order
    expect(mockMedusaAdmin).toHaveBeenCalledWith(
      `/admin/orders/${orderId}/cancel`,
      { method: "POST" },
    );
  });

  // ── NATS event published ──────────────────────────────────────────────────

  it("publishes payment.pix_expired NATS event with correct subject and payload", async () => {
    const orderId = "order_expired_02";
    const createdAt = expiredTimestamp();

    mockMedusaAdmin.mockResolvedValueOnce({
      orders: [
        {
          id: orderId,
          status: "pending",
          created_at: createdAt,
          metadata: { customerId: "cus_02" },
        },
      ],
    });
    mockMedusaAdmin.mockResolvedValueOnce({});
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkPixExpiry();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.pix_expired",
      expect.objectContaining({
        eventType: "payment.pix_expired",
        orderId,
        customerId: "cus_02",
        createdAt,
      }),
    );
  });

  // ── Skip recent orders ────────────────────────────────────────────────────

  it("skips orders within the expiry window", async () => {
    // The Medusa query uses a `created_at[lt]` filter so Medusa itself filters
    // out non-expired orders. An empty list simulates no expired orders.
    mockMedusaAdmin.mockResolvedValueOnce({ orders: [] });
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkPixExpiry();

    // Cancel endpoint must NOT be called
    expect(mockMedusaAdmin).toHaveBeenCalledTimes(1); // only the list call
    expect(mockMedusaAdmin).not.toHaveBeenCalledWith(
      expect.stringContaining("/cancel"),
      expect.anything(),
    );
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Multiple expired orders ───────────────────────────────────────────────

  it("processes all expired orders in the response", async () => {
    mockMedusaAdmin
      .mockResolvedValueOnce({
        orders: [
          { id: "order_a", status: "pending", created_at: expiredTimestamp(), metadata: {} },
          { id: "order_b", status: "pending", created_at: expiredTimestamp(), metadata: {} },
          { id: "order_c", status: "pending", created_at: expiredTimestamp(), metadata: {} },
        ],
      })
      .mockResolvedValue({}); // cancel calls
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkPixExpiry();

    // 1 list call + 3 cancel calls
    expect(mockMedusaAdmin).toHaveBeenCalledTimes(4);
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
  });

  // ── Empty orders list ─────────────────────────────────────────────────────

  it("handles missing orders field gracefully (undefined)", async () => {
    mockMedusaAdmin.mockResolvedValueOnce({});

    await expect(checkPixExpiry()).resolves.toBeUndefined();

    expect(mockMedusaAdmin).toHaveBeenCalledTimes(1);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Error per order — continues processing ────────────────────────────────

  it("continues processing remaining orders when one cancel fails", async () => {
    mockMedusaAdmin
      .mockResolvedValueOnce({
        orders: [
          { id: "order_fail", status: "pending", created_at: expiredTimestamp(), metadata: {} },
          { id: "order_ok", status: "pending", created_at: expiredTimestamp(), metadata: {} },
        ],
      })
      .mockRejectedValueOnce(new Error("Medusa 500")) // cancel order_fail
      .mockResolvedValueOnce({}); // cancel order_ok
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const log = buildMockLogger();
    await checkPixExpiry(log);

    // Error captured in Sentry for the failing order
    expect(mockSentryWithScope).toHaveBeenCalled();
    expect(mockSentryCaptureException).toHaveBeenCalled();

    // Second order still published
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.pix_expired",
      expect.objectContaining({ orderId: "order_ok" }),
    );
  });

  // ── Top-level query failure ───────────────────────────────────────────────

  it("captures Sentry exception when the Medusa order list query fails", async () => {
    mockMedusaAdmin.mockRejectedValueOnce(new Error("Medusa unreachable"));

    const log = buildMockLogger();
    await checkPixExpiry(log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Medusa unreachable") }),
      "[pix-expiry] Error querying pending orders",
    );
    expect(mockSentryWithScope).toHaveBeenCalled();
    expect(mockSentryCaptureException).toHaveBeenCalled();
  });

  // ── Logger receives completion summary ────────────────────────────────────

  it("logs completion summary after run", async () => {
    mockMedusaAdmin.mockResolvedValueOnce({ orders: [] });

    const log = buildMockLogger();
    await checkPixExpiry(log);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ expired_count: 0 }),
      "PIX expiry check complete",
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
