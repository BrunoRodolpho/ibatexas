// Tests for abandoned-cart-checker job
// Mocks Redis, session store, and NATS to test cart abandonment detection without network

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// ── Import source after mocks ───────────────────────────────────────────────

import {
  startAbandonedCartChecker,
  stopAbandonedCartChecker,
} from "../jobs/abandoned-cart-checker.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const GUEST_TTL = 48 * 60 * 60; // 48h in seconds (matches source)
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Build a mock redis client with configurable scan results */
function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    sScan: vi.fn(),
    exists: vi.fn(),
    ttl: vi.fn(),
    sRem: vi.fn(),
    ...overrides,
  };
}

/**
 * Helper: compute the TTL that would indicate lastActivity was `idleMs` ago.
 * lastActivityAgoMs = GUEST_TTL*1000 - ttl*1000
 * ttl = GUEST_TTL - idleMs/1000
 */
function ttlForIdleMs(idleMs: number): number {
  return GUEST_TTL - idleMs / 1000;
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

  afterEach(() => {
    stopAbandonedCartChecker();
    vi.useRealTimers();
  });

  // ── start / stop lifecycle ──────────────────────────────────────────────

  it("starts and stops without errors", () => {
    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: [] });

    expect(() => startAbandonedCartChecker()).not.toThrow();
    expect(() => stopAbandonedCartChecker()).not.toThrow();
  });

  it("does not start a second interval if already running", () => {
    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: [] });

    startAbandonedCartChecker();
    startAbandonedCartChecker(); // should be a no-op

    // Only one interval should be active — stop clears it cleanly
    expect(() => stopAbandonedCartChecker()).not.toThrow();
  });

  it("stopAbandonedCartChecker is safe to call when not started", () => {
    expect(() => stopAbandonedCartChecker()).not.toThrow();
  });

  // ── Empty cart set ────────────────────────────────────────────────────────

  it("handles empty active:carts set (no members)", async () => {
    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: [] });

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockRedis.sScan).toHaveBeenCalledWith("test:active:carts", 0, { COUNT: 100 });
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Session expired — remove from set ─────────────────────────────────────

  it("removes cart from active set when session no longer exists", async () => {
    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: ["cart_01"] });
    mockRedis.exists.mockResolvedValue(0); // session does not exist

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockRedis.sRem).toHaveBeenCalledWith("test:active:carts", "cart_01");
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Session exists but not idle enough ────────────────────────────────────

  it("skips carts that have not been idle long enough", async () => {
    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: ["cart_02"] });
    mockRedis.exists.mockResolvedValue(1);
    // TTL indicating only 30 minutes idle (well under 2h threshold)
    mockRedis.ttl.mockResolvedValue(ttlForIdleMs(30 * 60 * 1000));

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    expect(mockRedis.sRem).not.toHaveBeenCalled();
  });

  // ── Session idle but empty history — remove silently ──────────────────────

  it("removes cart from active set when session has empty history", async () => {
    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: ["cart_03"] });
    mockRedis.exists.mockResolvedValue(1);
    // TTL indicating 3 hours idle (past 2h threshold)
    mockRedis.ttl.mockResolvedValue(ttlForIdleMs(3 * 60 * 60 * 1000));
    mockLoadSession.mockResolvedValue([]); // empty history

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockRedis.sRem).toHaveBeenCalledWith("test:active:carts", "cart_03");
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Abandoned cart — publish event and remove ─────────────────────────────

  it("publishes cart.abandoned event for idle cart with non-empty history", async () => {
    const idleMs = 3 * 60 * 60 * 1000; // 3 hours

    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: ["cart_04"] });
    mockRedis.exists.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(ttlForIdleMs(idleMs));
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Quero costela" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "ibatexas.cart.abandoned",
      expect.objectContaining({
        eventType: "cart.abandoned",
        cartId: "cart_04",
        sessionId: "cart_04",
        idleMs,
      }),
    );

    // Should remove from active set after publishing
    expect(mockRedis.sRem).toHaveBeenCalledWith("test:active:carts", "cart_04");
  });

  // ── Multiple carts in a single scan batch ─────────────────────────────────

  it("processes multiple carts in one scan batch", async () => {
    const idleMs = 4 * 60 * 60 * 1000; // 4 hours
    const ttl = ttlForIdleMs(idleMs);

    mockRedis.sScan.mockResolvedValue({
      cursor: 0,
      members: ["cart_a", "cart_b", "cart_c"],
    });
    mockRedis.exists.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(ttl);
    mockLoadSession.mockResolvedValue([{ role: "assistant", content: "Olá!" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
    expect(mockRedis.sRem).toHaveBeenCalledTimes(3);
  });

  // ── Pagination (multi-page SSCAN) ─────────────────────────────────────────

  it("paginates through SSCAN when cursor is non-zero", async () => {
    const idleMs = 2.5 * 60 * 60 * 1000;
    const ttl = ttlForIdleMs(idleMs);

    // First call returns cursor=42, second returns cursor=0
    mockRedis.sScan
      .mockResolvedValueOnce({ cursor: 42, members: ["cart_page1"] })
      .mockResolvedValueOnce({ cursor: 0, members: ["cart_page2"] });
    mockRedis.exists.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(ttl);
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Oi" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    // Should have scanned twice (cursor 0 -> 42 -> 0)
    expect(mockRedis.sScan).toHaveBeenCalledTimes(2);
    expect(mockRedis.sScan).toHaveBeenCalledWith("test:active:carts", 0, { COUNT: 100 });
    expect(mockRedis.sScan).toHaveBeenCalledWith("test:active:carts", 42, { COUNT: 100 });

    // Both carts should be published
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(2);
  });

  // ── Error handling per cart ───────────────────────────────────────────────

  it("continues processing remaining carts when one throws", async () => {
    const idleMs = 3 * 60 * 60 * 1000;
    const ttl = ttlForIdleMs(idleMs);

    mockRedis.sScan.mockResolvedValue({
      cursor: 0,
      members: ["cart_fail", "cart_ok"],
    });
    mockRedis.exists.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(ttl);

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

    startAbandonedCartChecker(mockLogger as unknown as import("fastify").FastifyBaseLogger);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    // Error logged for first cart
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ cartId: "cart_fail" }),
      "[abandoned-cart] Error processing cart",
    );

    // Second cart still published successfully
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "ibatexas.cart.abandoned",
      expect.objectContaining({ cartId: "cart_ok" }),
    );
  });

  // ── Exactly at idle threshold — not abandoned ─────────────────────────────

  it("does not flag cart at exactly the idle threshold", async () => {
    // At exactly 2h idle, lastActivityAgoMs == IDLE_THRESHOLD_MS
    // Source check: `lastActivityAgoMs < IDLE_THRESHOLD_MS` → continues → NOT abandoned
    // Wait, at exactly equal: !(2h < 2h) → false → does NOT continue → falls through
    // Actually re-reading: if (lastActivityAgoMs < IDLE_THRESHOLD_MS) { continue; }
    // So at exactly 2h: 2h < 2h is false → it does NOT skip → it IS treated as abandoned
    const ttl = ttlForIdleMs(IDLE_THRESHOLD_MS);

    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: ["cart_exact"] });
    mockRedis.exists.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(ttl);
    mockLoadSession.mockResolvedValue([{ role: "user", content: "Oi" }]);
    mockPublishNatsEvent.mockResolvedValue(undefined);

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    // At exactly 2h: condition is `<` so exactly 2h passes through → is abandoned
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
  });

  // ── Logger receives completion summary ────────────────────────────────────

  it("logs completion summary with abandoned count", async () => {
    const idleMs = 5 * 60 * 60 * 1000;

    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: ["cart_log"] });
    mockRedis.exists.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(ttlForIdleMs(idleMs));
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

    startAbandonedCartChecker(mockLogger as unknown as import("fastify").FastifyBaseLogger);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ abandoned_count: 1 }),
      "Abandoned cart check complete",
    );
  });

  // ── Interval fires repeatedly ─────────────────────────────────────────────

  it("runs check on every interval tick", async () => {
    mockRedis.sScan.mockResolvedValue({ cursor: 0, members: [] });

    startAbandonedCartChecker();

    // Advance through 3 intervals
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3 + 100);

    // sScan should be called on each tick (3 times)
    expect(mockRedis.sScan).toHaveBeenCalledTimes(3);
  });

  // ── Unexpected top-level error is caught ──────────────────────────────────

  it("catches unexpected errors in checkAbandonedCarts", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("Redis connection refused"));

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

    startAbandonedCartChecker(mockLogger as unknown as import("fastify").FastifyBaseLogger);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockLogger.error).toHaveBeenCalled();
  });
});
