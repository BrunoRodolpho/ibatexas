// Redis circuit breaker — fast-fail on non-critical paths when Redis is down.
//
// Three states:
//   CLOSED    — normal operation; all commands pass through
//   OPEN      — Redis is failing; non-critical ops return null immediately
//   HALF_OPEN — testing recovery; one probe request allowed through
//
// After `failureThreshold` consecutive failures the circuit trips OPEN.
// After `resetTimeoutMs` in OPEN state it transitions to HALF_OPEN.
// A single success in HALF_OPEN resets to CLOSED.

export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before the circuit trips open. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait in OPEN before allowing a probe request. Default: 30 000 */
  resetTimeoutMs?: number;
}

export class RedisCircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold =
      opts?.failureThreshold ??
      Number.parseInt(process.env.REDIS_CB_FAILURE_THRESHOLD ?? "5", 10);
    this.resetTimeoutMs =
      opts?.resetTimeoutMs ??
      Number.parseInt(process.env.REDIS_CB_RESET_TIMEOUT_MS ?? "30000", 10);
  }

  /** Current circuit state (for monitoring / tests). */
  get currentState(): CircuitState {
    return this.state;
  }

  /** True when the circuit is OPEN and the reset timeout has NOT elapsed. */
  get isOpen(): boolean {
    if (this.state !== CircuitState.OPEN) return false;
    // Check if enough time has passed to transition to HALF_OPEN
    if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = CircuitState.HALF_OPEN;
      return false;
    }
    return true;
  }

  /** Record a successful Redis operation — resets the circuit to CLOSED. */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  /** Record a failed Redis operation — increments counter, trips OPEN if threshold reached. */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  /**
   * Check if a request should be allowed through.
   *
   * @returns `true` if this is a HALF_OPEN probe request (caller should treat
   *          success/failure carefully). Returns `false` for normal CLOSED traffic.
   * @throws {CircuitOpenError} if the circuit is OPEN and no requests should pass.
   */
  checkState(): boolean {
    if (this.state === CircuitState.CLOSED) return false;

    if (this.state === CircuitState.OPEN) {
      // Check if reset timeout has elapsed
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        return true; // Allow one probe
      }
      throw new CircuitOpenError(this.resetTimeoutMs - (Date.now() - this.lastFailureTime));
    }

    // HALF_OPEN — allow the probe
    return true;
  }
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Redis circuit breaker is OPEN — retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ── Singleton instance ────────────────────────────────────────────────────────

let instance: RedisCircuitBreaker | null = null;

/** Get the shared circuit breaker singleton (lazy-init). */
export function getCircuitBreaker(opts?: CircuitBreakerOptions): RedisCircuitBreaker {
  if (!instance) {
    instance = new RedisCircuitBreaker(opts);
  }
  return instance;
}

/** Reset singleton — only for tests. */
export function resetCircuitBreaker(): void {
  instance = null;
}
