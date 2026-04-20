// Tests for abandoned-cart-checker job
// Mocks Redis, session store, and NATS to test cart abandonment detection without network.
// Tests call the exported checkAbandonedCarts() processor directly (BullMQ is mocked).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkAbandonedCarts,
  startAbandonedCartChecker,
  stopAbandonedCartChecker,
} from "../jobs/abandoned-cart-checker.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockLoadSession = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

// ── Mocks (before imports) ──────────────────────────────────────────────────

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../session/store.js", () => ({
  loadSession: mockLoadSession,
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

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => cb({ setTag: vi.fn(), setContext: vi.fn() })),
  captureException: vi.fn(),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h

/** Build a JSON entry for the active:carts hash */
function cartEntry(cartId: string, sessionType: "guest" | "customer", idleMs: number): string {
  return JSON.stringify({ cartId, sessionType, lastActivity: Date.now() - idleMs });
}

/** Build a mock redis client with configurable hScan results */
function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    hScan: vi.fn(),
    hDel: vi.fn(),
    hSet: vi.fn(),
    hGet: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    exists: vi.fn(),
    ttl: vi.fn(),
    ...overrides,
  };
}

describe("abandoned-cart-checker", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    // rk just returns a prefixed key for tests
    mockRk.mockImplementation((key: string) => `test:${key}`);
  });

  afterEach(async () => {
    await stopAbandonedCartChecker();
    vi.useRealTimers();
  });

  // ── start / stop lifecycle ──────────────────────────────────────────────

  it("starts and stops without errors", async () => {
    expect(() => startAbandonedCartChecker()).not.toThrow();
    await expect(stopAbandonedCartChecker()).resolves.toBeUndefined();
  });

  it("does not start a second worker if already running", () => {
    startAbandonedCartChecker();
    // Second call should be a no-op
    expect(() => startAbandonedCartChecker()).not.toThrow();
  });

  it("stopAbandonedCartChecker is safe to call when not started", async () => {
    await expect(stopAbandonedCartChecker()).resolves.toBeUndefined();
  });

  // ── Empty cart hash ────────────────────────────────────────────────────────

  it("handles empty active:carts hash (no tuples)", async () => {
    mockRedis.hScan.mockResolvedValue({ cursor: 0, tuples: [] });

    await checkAbandonedCarts();

    expect(mockRedis.hScan).toHaveBeenCalledWith("test:active:carts", 0, { COUNT: 100 });
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Cart not idle enough ─────────────────────────────────────────────

  it("skips carts that have not been idle long enough", async () => {
    const idleMs = 30 * 60 * 1000; // 30 minutes
    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_02", value: cartEntry("cart_02", "guest", idleMs) }],
    });

    await checkAbandonedCarts();

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    expect(mockRedis.hDel).not.toHaveBeenCalled();
  });

  // ── Session idle but empty history — remove silently ──────────────────────

  it("removes cart from active hash when session has empty history", async () => {
    const idleMs = 3 * 60 * 60 * 1000; // 3 hours
    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_03", value: cartEntry("cart_03", "guest", idleMs) }],
    });
    mockLoadSession.mockResolvedValue([]); // empty history

    await checkAbandonedCarts();

    expect(mockRedis.hDel).toHaveBeenCalledWith("test:active:carts", "cart_03");
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Abandoned cart — publish event and remove ─────────────────────────────

  it("publishes cart.abandoned event for idle cart with non-empty history", async () => {
    const idleMs = 3 * 60 * 60 * 1000; // 3 hours

    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_04", value: cartEntry("cart_04", "guest", idleMs) }],
    });
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Quero costela" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkAbandonedCarts();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({
        eventType: "cart.abandoned",
        cartId: "cart_04",
        sessionId: "cart_04",
        sessionType: "guest",
      }),
    );

    // No nudge key exists (first detection) → re-arm cart for next tier scan (hSet, not hDel)
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      "test:active:carts",
      "cart_04",
      expect.any(String),
    );
  });

  // ── Multiple carts in a single scan batch ─────────────────────────────────

  it("processes multiple carts in one scan batch", async () => {
    const idleMs = 4 * 60 * 60 * 1000; // 4 hours

    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [
        { field: "cart_a", value: cartEntry("cart_a", "guest", idleMs) },
        { field: "cart_b", value: cartEntry("cart_b", "customer", idleMs) },
        { field: "cart_c", value: cartEntry("cart_c", "guest", idleMs) },
      ],
    });
    mockLoadSession.mockResolvedValue([{ role: "assistant", content: "Ola!" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkAbandonedCarts();

    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
    // No nudge keys exist (first detection) → all carts re-armed (hSet, not hDel)
    expect(mockRedis.hSet).toHaveBeenCalledTimes(3);
  });

  // ── Pagination (multi-page HSCAN) ─────────────────────────────────────────

  it("paginates through HSCAN when cursor is non-zero", async () => {
    const idleMs = 2.5 * 60 * 60 * 1000;

    // First call returns cursor=42, second returns cursor=0
    mockRedis.hScan
      .mockResolvedValueOnce({
        cursor: 42,
        tuples: [{ field: "cart_page1", value: cartEntry("cart_page1", "guest", idleMs) }],
      })
      .mockResolvedValueOnce({
        cursor: 0,
        tuples: [{ field: "cart_page2", value: cartEntry("cart_page2", "guest", idleMs) }],
      });
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Oi" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkAbandonedCarts();

    // Should have scanned twice (cursor 0 -> 42 -> 0)
    expect(mockRedis.hScan).toHaveBeenCalledTimes(2);
    expect(mockRedis.hScan).toHaveBeenCalledWith("test:active:carts", 0, { COUNT: 100 });
    expect(mockRedis.hScan).toHaveBeenCalledWith("test:active:carts", 42, { COUNT: 100 });

    // Both carts should be published
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(2);
  });

  // ── Error handling per cart ───────────────────────────────────────────────

  it("continues processing remaining carts when one throws", async () => {
    const idleMs = 3 * 60 * 60 * 1000;

    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [
        { field: "cart_fail", value: cartEntry("cart_fail", "guest", idleMs) },
        { field: "cart_ok", value: cartEntry("cart_ok", "guest", idleMs) },
      ],
    });

    // First loadSession throws, second succeeds
    mockLoadSession
      .mockRejectedValueOnce(new Error("Redis timeout"))
      .mockResolvedValueOnce([{ role: "user", content: "Pedido" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      silent: vi.fn(),
      level: "info",
    };

    await checkAbandonedCarts(mockLogger as unknown as import("fastify").FastifyBaseLogger);

    // Error logged for first cart
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ cartId: "cart_fail" }),
      "[abandoned-cart] Error processing cart",
    );

    // Second cart still published successfully
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({ cartId: "cart_ok" }),
    );
  });

  // ── Exactly at idle threshold — is abandoned ─────────────────────────

  it("flags cart at exactly the idle threshold as abandoned", async () => {
    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_exact", value: cartEntry("cart_exact", "guest", IDLE_THRESHOLD_MS) }],
    });
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Oi" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkAbandonedCarts();

    // At exactly 2h: condition is `<` so exactly 2h passes through -> is abandoned
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
  });

  // ── Logger receives completion summary ────────────────────────────────────

  it("logs completion summary with abandoned count", async () => {
    const idleMs = 5 * 60 * 60 * 1000;

    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_log", value: cartEntry("cart_log", "guest", idleMs) }],
    });
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Menu" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      silent: vi.fn(),
      level: "info",
    };

    await checkAbandonedCarts(mockLogger as unknown as import("fastify").FastifyBaseLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ abandoned_count: 1 }),
      "Abandoned cart check complete",
    );
  });

  // ── Unexpected top-level error is caught ──────────────────────────────────

  it("throws unexpected errors from checkAbandonedCarts for BullMQ to handle", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("Redis connection refused"));

    await expect(checkAbandonedCarts()).rejects.toThrow("Redis connection refused");
  });

  // ── Legacy entry fallback ─────────────────────────────────────────────────

  it("handles legacy entries (bare cartId) by falling back to session TTL", async () => {
    const GUEST_TTL = 48 * 60 * 60;
    const idleMs = 3 * 60 * 60 * 1000; // 3 hours
    const ttlSeconds = GUEST_TTL - idleMs / 1000;

    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_legacy", value: "cart_legacy" }], // bare string, not JSON
    });
    mockRedis.exists.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(ttlSeconds);
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Oi" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await checkAbandonedCarts();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({
        cartId: "cart_legacy",
      }),
    );
  });

  it("removes legacy entry when session no longer exists", async () => {
    mockRedis.hScan.mockResolvedValue({
      cursor: 0,
      tuples: [{ field: "cart_old", value: "cart_old" }], // bare string, not JSON
    });
    mockRedis.exists.mockResolvedValue(0); // session expired

    await checkAbandonedCarts();

    expect(mockRedis.hDel).toHaveBeenCalledWith("test:active:carts", "cart_old");
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});
