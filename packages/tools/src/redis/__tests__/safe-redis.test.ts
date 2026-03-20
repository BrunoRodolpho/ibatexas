// Tests for safeRedis wrapper
// Validates circuit breaker integration with Redis operations.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());

vi.mock("../client.js", () => ({
  getRedisClient: mockGetRedisClient,
}));

// ── Imports after mocks ─────────────────────────────────────────────────────

import { safeRedis } from "../safe-redis.js";
import { resetCircuitBreaker, getCircuitBreaker, CircuitOpenError } from "../circuit-breaker.js";

describe("safeRedis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreaker();
  });

  afterEach(() => {
    resetCircuitBreaker();
  });

  // ── Normal operation ──────────────────────────────────────────────────────

  it("passes through Redis operations when circuit is CLOSED", async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue("value") };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const result = await safeRedis("non-critical", (r) => r.get("key"));
    expect(result).toBe("value");
  });

  it("records success after a successful operation", async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue("ok") };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const cb = getCircuitBreaker({ failureThreshold: 5 });
    // Simulate a few failures (not enough to trip)
    cb.recordFailure();
    cb.recordFailure();

    await safeRedis("non-critical", (r) => r.get("key"));

    // After safeRedis success, the circuit breaker should be CLOSED with count reset
    expect(cb.currentState).toBe("closed");
  });

  // ── Non-critical path when circuit is open ────────────────────────────────

  it("returns null for non-critical operations when circuit is OPEN", async () => {
    const cb = getCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure(); // trips to OPEN

    const result = await safeRedis("non-critical", () => {
      throw new Error("should not be called");
    });

    expect(result).toBeNull();
  });

  it("returns custom fallback for non-critical operations when circuit is OPEN", async () => {
    const cb = getCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();

    const result = await safeRedis(
      "non-critical",
      () => {
        throw new Error("should not be called");
      },
      [],
    );

    expect(result).toEqual([]);
  });

  // ── Critical path when circuit is open ────────────────────────────────────

  it("throws CircuitOpenError for critical operations when circuit is OPEN", async () => {
    const cb = getCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();

    await expect(
      safeRedis("critical", () => {
        throw new Error("should not be called");
      }),
    ).rejects.toThrow(CircuitOpenError);
  });

  // ── Non-critical: returns null on operation failure ────────────────────────

  it("returns null for non-critical operations when Redis throws", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("Connection refused"));

    const result = await safeRedis("non-critical", (r) => r.get("key"));
    expect(result).toBeNull();
  });

  it("records failure when Redis operation throws", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("Connection refused"));
    const cb = getCircuitBreaker({ failureThreshold: 3 });

    await safeRedis("non-critical", (r) => r.get("key"));
    await safeRedis("non-critical", (r) => r.get("key"));
    await safeRedis("non-critical", (r) => r.get("key"));

    // After 3 failures, circuit should be OPEN
    expect(cb.currentState).toBe("open");
  });

  // ── Critical: throws on operation failure ─────────────────────────────────

  it("throws the original error for critical operations when Redis throws", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("Connection refused"));

    await expect(
      safeRedis("critical", (r) => r.get("key")),
    ).rejects.toThrow("Connection refused");
  });

  // ── Recovery (HALF_OPEN → CLOSED) ─────────────────────────────────────────

  it("recovers from OPEN through HALF_OPEN to CLOSED on success", async () => {
    vi.useFakeTimers();

    const cb = getCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000 });
    cb.recordFailure(); // OPEN

    // Non-critical should return null while OPEN
    const openResult = await safeRedis("non-critical", () => {
      throw new Error("should not be called");
    });
    expect(openResult).toBeNull();

    // Advance time past reset timeout
    vi.advanceTimersByTime(5_000);

    // Now the circuit should allow a probe — we need the operation to succeed
    const mockRedis = { get: vi.fn().mockResolvedValue("recovered") };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const result = await safeRedis("non-critical", (r) => r.get("key"));
    expect(result).toBe("recovered");
    expect(cb.currentState).toBe("closed");

    vi.useRealTimers();
  });
});
