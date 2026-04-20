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
  const redis = await getRedisClient()
  const key = rk(`lock:${resource}`)
  const value = randomUUID()

  const acquired = await redis.set(key, value, { EX: ttlSeconds, NX: true })
  if (!acquired) return null

  return {
    key,
    value,
    async release() {
      const r = await getRedisClient()
      await r.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [value] })
    },
  }
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
