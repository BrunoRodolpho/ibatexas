// Tests for RedisCircuitBreaker
// Validates state transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
// and the singleton accessor getCircuitBreaker / resetCircuitBreaker.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RedisCircuitBreaker,
  CircuitState,
  CircuitOpenError,
  getCircuitBreaker,
  resetCircuitBreaker,
} from "../circuit-breaker.js";

describe("RedisCircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCircuitBreaker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it("starts in CLOSED state", () => {
    const cb = new RedisCircuitBreaker();
    expect(cb.currentState).toBe(CircuitState.CLOSED);
    expect(cb.isOpen).toBe(false);
  });

  // ── CLOSED → OPEN after threshold failures ─────────────────────────────────

  it("transitions from CLOSED to OPEN after failureThreshold failures", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 3 });

    cb.recordFailure();
    expect(cb.currentState).toBe(CircuitState.CLOSED);

    cb.recordFailure();
    expect(cb.currentState).toBe(CircuitState.CLOSED);

    cb.recordFailure(); // 3rd failure — trips the circuit
    expect(cb.currentState).toBe(CircuitState.OPEN);
    expect(cb.isOpen).toBe(true);
  });

  // ── checkState throws when OPEN ────────────────────────────────────────────

  it("checkState throws CircuitOpenError when circuit is OPEN", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 });
    cb.recordFailure();

    expect(() => cb.checkState()).toThrow(CircuitOpenError);
  });

  it("CircuitOpenError includes retryAfterMs", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000 });
    cb.recordFailure();

    try {
      cb.checkState();
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
      expect((err as CircuitOpenError).retryAfterMs).toBeLessThanOrEqual(30_000);
    }
  });

  // ── OPEN → HALF_OPEN after resetTimeoutMs ──────────────────────────────────

  it("transitions from OPEN to HALF_OPEN after resetTimeoutMs", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000 });
    cb.recordFailure(); // OPEN
    expect(cb.currentState).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(5_000);

    // isOpen should now be false (triggers transition to HALF_OPEN)
    expect(cb.isOpen).toBe(false);
    expect(cb.currentState).toBe(CircuitState.HALF_OPEN);
  });

  it("checkState returns true (probe) in HALF_OPEN", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000 });
    cb.recordFailure(); // OPEN

    vi.advanceTimersByTime(5_000);

    // checkState should NOT throw — it returns true to signal a probe request
    const isProbe = cb.checkState();
    expect(isProbe).toBe(true);
  });

  it("checkState transitions OPEN to HALF_OPEN when timeout has elapsed", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000 });
    cb.recordFailure(); // OPEN

    vi.advanceTimersByTime(5_000);

    const isProbe = cb.checkState();
    expect(isProbe).toBe(true);
    expect(cb.currentState).toBe(CircuitState.HALF_OPEN);
  });

  // ── HALF_OPEN → CLOSED on success ─────────────────────────────────────────

  it("transitions from HALF_OPEN to CLOSED on recordSuccess", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000 });
    cb.recordFailure(); // OPEN

    vi.advanceTimersByTime(5_000);
    cb.checkState(); // transitions to HALF_OPEN
    expect(cb.currentState).toBe(CircuitState.HALF_OPEN);

    cb.recordSuccess(); // CLOSED
    expect(cb.currentState).toBe(CircuitState.CLOSED);
    expect(cb.isOpen).toBe(false);
  });

  // ── HALF_OPEN → OPEN on failure ───────────────────────────────────────────

  it("transitions from HALF_OPEN back to OPEN on recordFailure", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000 });
    cb.recordFailure(); // OPEN

    vi.advanceTimersByTime(5_000);
    cb.checkState(); // HALF_OPEN

    cb.recordFailure(); // back to OPEN
    expect(cb.currentState).toBe(CircuitState.OPEN);
  });

  // ── recordSuccess resets failure count ─────────────────────────────────────

  it("recordSuccess resets failure count so subsequent failures start fresh", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 3 });

    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // reset count to 0

    cb.recordFailure();
    cb.recordFailure();
    // Only 2 failures since reset — should still be CLOSED
    expect(cb.currentState).toBe(CircuitState.CLOSED);
  });

  // ── checkState returns false when CLOSED ──────────────────────────────────

  it("checkState returns false for normal CLOSED traffic", () => {
    const cb = new RedisCircuitBreaker();
    expect(cb.checkState()).toBe(false);
  });

  // ── OPEN: isOpen returns true before timeout ──────────────────────────────

  it("isOpen returns true when OPEN and timeout has NOT elapsed", () => {
    const cb = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 });
    cb.recordFailure();

    vi.advanceTimersByTime(5_000); // only half the timeout
    expect(cb.isOpen).toBe(true);
  });

  // ── Default threshold from env ────────────────────────────────────────────

  it("reads failureThreshold from REDIS_CB_FAILURE_THRESHOLD env var", () => {
    process.env.REDIS_CB_FAILURE_THRESHOLD = "2";
    const cb = new RedisCircuitBreaker();

    cb.recordFailure();
    expect(cb.currentState).toBe(CircuitState.CLOSED);

    cb.recordFailure(); // 2nd failure trips
    expect(cb.currentState).toBe(CircuitState.OPEN);

    delete process.env.REDIS_CB_FAILURE_THRESHOLD;
  });

  it("reads resetTimeoutMs from REDIS_CB_RESET_TIMEOUT_MS env var", () => {
    process.env.REDIS_CB_RESET_TIMEOUT_MS = "2000";
    const cb = new RedisCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();

    vi.advanceTimersByTime(2000);
    expect(cb.isOpen).toBe(false);
    expect(cb.currentState).toBe(CircuitState.HALF_OPEN);

    delete process.env.REDIS_CB_RESET_TIMEOUT_MS;
  });

  // ── Singleton ─────────────────────────────────────────────────────────────

  it("getCircuitBreaker returns the same instance", () => {
    const a = getCircuitBreaker();
    const b = getCircuitBreaker();
    expect(a).toBe(b);
  });

  it("resetCircuitBreaker creates a fresh instance", () => {
    const a = getCircuitBreaker();
    a.recordFailure();

    resetCircuitBreaker();
    const b = getCircuitBreaker();

    expect(b).not.toBe(a);
    expect(b.currentState).toBe(CircuitState.CLOSED);
  });
});
