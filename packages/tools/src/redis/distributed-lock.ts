// Distributed lock utility — Redis SET NX with UUID ownership + Lua conditional release.
//
// Pattern: same as session.ts agent lock and outbox-retry.ts.
// Rule: never use plain redis.del() to release — always ownership-checked Lua.

import { randomUUID } from "node:crypto"
import { getRedisClient } from "./client.js"
import { rk } from "./key.js"

/** Lua script: conditional DEL — only deletes if the lock value matches. */
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

export interface LockHandle {
  key: string
  value: string
  release: () => Promise<void>
}

/**
 * The Redis surface a lock acquisition + ownership-checked release issues.
 *
 * Exactly two commands, both genuinely ISSUED (the R5-S12 fail-closed Pick
 * analysis): `set` for the NX claim, `eval` for the compare-and-delete release.
 * Declaring it structurally rather than as a `Pick<RedisClientType, …>` keeps
 * the contract readable at the call site and lets any client that honours these
 * two signatures serve a lock — including the NARROWED per-family clients the
 * R5 rollout threads through routes (`CartRouteRedisClient` satisfies it).
 *
 * There is deliberately NO `del`: after F-21 nothing on this path issues an
 * unconditional DEL, so a client that only knows how to `del` cannot serve a
 * lock and `tsc` says so.
 */
export interface LockRedisClient {
  set(
    key: string,
    value: string,
    options: { EX: number; NX: true },
  ): Promise<string | null>
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>
}

/**
 * The singleton-backed {@link LockRedisClient}.
 *
 * Resolves `getRedisClient()` PER COMMAND, which is what keeps
 * {@link acquireLockAtKey} behaviour-identical to its pre-injection form: that
 * function resolved the client at acquire time and re-resolved it at release
 * time. Capturing one client at acquire would have been a quiet change to when
 * the resolution happens; this preserves it exactly.
 */
const singletonLockClient: LockRedisClient = {
  async set(key, value, options) {
    const redis = await getRedisClient()
    return (await redis.set(key, value, options)) as string | null
  },
  async eval(script, options) {
    const redis = await getRedisClient()
    return redis.eval(script, options)
  },
}

/**
 * Acquire a distributed lock AT AN ALREADY-BUILT KEY, ON A GIVEN CLIENT.
 *
 * The injected-client form of {@link acquireLockAtKey}, following the repo's
 * injected-first-parameter precedent (`atomicIncr(redis, key, ttl)` in
 * `redis/atomic-rate-limit.ts`). It exists because the R5 rollout (PR #524)
 * THREADS a Redis client down each route family — `routes/cart.ts` resolves
 * every Redis touch through `CartRouteDeps.redis` — and a lock helper that
 * reached for the singleton internally would reintroduce exactly the hidden
 * global that rollout removed. A threaded route must be able to take a lock ON
 * ITS OWN CLIENT, or the seam is a lie for the one operation that most needs to
 * be observable in a test.
 *
 * @param redis - The client the claim and its release both run on.
 * @param key - A key ALREADY built with `rk()` (Hard Rule #7). Never a raw string.
 * @param ttlSeconds - Lock TTL in seconds (default 10).
 * @returns LockHandle if acquired, null if already held.
 */
export async function acquireLockAtKeyOn(
  redis: LockRedisClient,
  key: string,
  ttlSeconds = 10,
): Promise<LockHandle | null> {
  const value = randomUUID()

  const acquired = await redis.set(key, value, { EX: ttlSeconds, NX: true })
  if (!acquired) return null

  return {
    key,
    value,
    async release() {
      await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [value] })
    },
  }
}

/**
 * Acquire a distributed lock AT AN ALREADY-BUILT KEY.
 *
 * The lower half of {@link acquireLock}, split out (F-21) for call sites that
 * own a key whose shape predates the `lock:<resource>` convention and cannot
 * change it without breaking mutual exclusion across a rolling deploy — e.g.
 * `rk("cart:create:lock:<sessionId>")` in `cart/get-or-create-cart.ts`. Such a
 * site must still get the ownership semantics, and it must get them from THIS
 * implementation rather than a second inline copy of the Lua.
 *
 * Runs on the process-wide singleton client. A call site that already holds a
 * client — every R5-threaded route family — should call
 * {@link acquireLockAtKeyOn} with it instead.
 *
 * @param key - A key ALREADY built with `rk()` (Hard Rule #7). Never a raw string.
 * @param ttlSeconds - Lock TTL in seconds (default 10).
 * @returns LockHandle if acquired, null if already held.
 */
export async function acquireLockAtKey(
  key: string,
  ttlSeconds = 10,
): Promise<LockHandle | null> {
  return acquireLockAtKeyOn(singletonLockClient, key, ttlSeconds)
}

/**
 * Acquire a distributed lock.
 *
 * @param resource - Lock resource name (e.g. "payment:abc123"). Will be prefixed with "lock:" via rk().
 * @param ttlSeconds - Lock TTL in seconds (default 10).
 * @returns LockHandle if acquired, null if already held.
 */
export async function acquireLock(
  resource: string,
  ttlSeconds = 10,
): Promise<LockHandle | null> {
  return acquireLockAtKey(rk(`lock:${resource}`), ttlSeconds)
}

/**
 * Execute a function while holding a distributed lock.
 * Automatically releases the lock when done (success or error).
 *
 * @returns The function result, or null if the lock could not be acquired.
 */
export async function withLock<T>(
  resource: string,
  fn: () => Promise<T>,
  ttlSeconds = 10,
): Promise<T | null> {
  const handle = await acquireLock(resource, ttlSeconds)
  if (!handle) return null

  try {
    return await fn()
  } finally {
    await handle.release()
  }
}
