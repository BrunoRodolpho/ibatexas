// Safe Redis wrapper — integrates circuit breaker with getRedisClient().
//
// Non-critical operations (cache, analytics, co-purchase) return null when the
// circuit is open. Critical operations (rate limits, session, outbox) throw so
// callers can implement retry / fallback.
//
// Usage:
//   const result = await safeRedis("non-critical", (redis) => redis.get(key));
//   // result is string | null — null when circuit is open
//
//   const count = await safeRedis("critical", (redis) => redis.incr(key));
//   // throws CircuitOpenError when circuit is open

import { getRedisClient } from "./client.js";
import { getCircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;
type Criticality = "critical" | "non-critical";

/**
 * Execute a Redis operation through the circuit breaker.
 *
 * @param criticality  `"critical"` throws when circuit is open;
 *                     `"non-critical"` returns `null`.
 * @param fn           The Redis operation to execute.
 * @param fallback     Optional fallback value for non-critical operations when
 *                     circuit is open. Defaults to `null`.
 * @returns            The operation result, or `fallback` when circuit is open
 *                     and criticality is non-critical.
 */
export async function safeRedis<T>(
  criticality: Criticality,
  fn: (redis: RedisClient) => Promise<T>,
  fallback?: T,
): Promise<T | null> {
  const cb = getCircuitBreaker();

  try {
    cb.checkState();
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      if (criticality === "critical") throw err;
      return fallback ?? null;
    }
    throw err;
  }

  try {
    const redis = await getRedisClient();
    const result = await fn(redis);
    cb.recordSuccess();
    return result;
  } catch (err) {
    cb.recordFailure();
    if (criticality === "non-critical") {
      return fallback ?? null;
    }
    throw err;
  }
}
