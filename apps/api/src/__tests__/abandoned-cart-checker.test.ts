// Tests for abandoned-cart-checker job
// Mocks Redis, session store, and NATS to test cart abandonment detection without network
//

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

const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Build a JSON entry for the active:carts hash */
function cartEntry(cartId: string, sessionType: "guest" | "customer", idleMs: number): string {
  return JSON.stringify({ cartId, sessionType, lastActivity: Date.now() - idleMs });
}

/** Build a mock redis client with configurable hScan results */
function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    hScan: vi.fn(),
    hDel: vi.fn(),
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

  afterEach(() => {
    stopAbandonedCartChecker();
    vi.useRealTimers();
  });

  // ── start / stop lifecycle ──────────────────────────────────────────────

  it("starts and stops without errors", () => {
    mockRedis.hScan.mockResolvedValue({ cursor: 0, tuples: [] });

    expect(() => startAbandonedCartChecker()).not.toThrow();
    expect(() => stopAbandonedCartChecker()).not.toThrow();
  });

  it("does not start a second interval if already running", () => {
    mockRedis.hScan.mockResolvedValue({ cursor: 0, tuples: [] });

    startAbandonedCartChecker();
    startAbandonedCartChecker(); // should be a no-op — only one interval created

    // Verify setInterval was called only once (first call), not twice
    expect(vi.getTimerCount()).toBe(1);

    stopAbandonedCartChecker();
  });

  it("stopAbandonedCartChecker is safe to call when not started", () => {
    expect(() => stopAbandonedCartChecker()).not.toThrow();
  });

  // ── Empty cart hash ────────────────────────────────────────────────────────

  it("handles empty active:carts hash (no tuples)", async () => {
    mockRedis.hScan.mockResolvedValue({ cursor: 0, tuples: [] });

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

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

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

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

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

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

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({
        eventType: "cart.abandoned",
        cartId: "cart_04",
        sessionId: "cart_04",
        sessionType: "guest",
      }),
    );

    // Should remove from active hash after publishing
    expect(mockRedis.hDel).toHaveBeenCalledWith("test:active:carts", "cart_04");
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

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
    expect(mockRedis.hDel).toHaveBeenCalledTimes(3);
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

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

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

    startAbandonedCartChecker(mockLogger as unknown as import("fastify").FastifyBaseLogger);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

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

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

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

    startAbandonedCartChecker(mockLogger as unknown as import("fastify").FastifyBaseLogger);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ abandoned_count: 1 }),
      "Abandoned cart check complete",
    );
  });

  // ── Interval fires repeatedly ─────────────────────────────────────────────

  it("runs check on every interval tick", async () => {
    mockRedis.hScan.mockResolvedValue({ cursor: 0, tuples: [] });

    startAbandonedCartChecker();

    // Advance through 3 intervals
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3 + 100);

    // hScan should be called on each tick (3 times)
    expect(mockRedis.hScan).toHaveBeenCalledTimes(3);
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

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

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

    startAbandonedCartChecker();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100);

    expect(mockRedis.hDel).toHaveBeenCalledWith("test:active:carts", "cart_old");
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});
