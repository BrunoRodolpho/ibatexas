// lib/redis.ts — shared Redis helpers.
// Extracted from intelligence.ts and test.ts to eliminate duplication.
// Re-exports rk() from @ibatexas/tools so CLI files import from one place.

// ── Re-export rk from @ibatexas/tools ────────────────────────────────────────
// rk() namespaces Redis keys with APP_ENV: `${APP_ENV}:${key}`
// CLAUDE.md rule: always use rk() — never build raw key strings inline.
export { rk } from "@ibatexas/tools"

// ── Types ────────────────────────────────────────────────────────────────────

export type RedisClient = Awaited<ReturnType<typeof import("@ibatexas/tools").getRedisClient>>

// ── Connection helpers ───────────────────────────────────────────────────────

/**
 * Get a connected Redis client.
 * Uses the shared singleton from @ibatexas/tools.
 */
export async function getRedis(): Promise<RedisClient> {
  const { getRedisClient } = await import("@ibatexas/tools")
  return getRedisClient()
}

/**
 * Close the shared Redis connection.
 * Call this in `finally` blocks so the CLI process exits cleanly.
 */
export async function closeRedis(): Promise<void> {
  const { closeRedisClient } = await import("@ibatexas/tools")
  await closeRedisClient()
}

// ── Scan utilities ───────────────────────────────────────────────────────────

/**
 * Delete all keys matching a glob pattern via SCAN + DEL.
 * Returns the number of keys deleted.
 */
export async function scanDelete(redis: RedisClient, pattern: string): Promise<number> {
  let cursor = 0
  let deleted = 0

  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
    cursor = result.cursor

    if (result.keys.length > 0) {
      await redis.del(result.keys)
      deleted += result.keys.length
    }
  } while (cursor !== 0)

  return deleted
}

/**
 * Count all keys matching a glob pattern via SCAN (no deletion).
 * Used by verify checks, debug commands, matrix verification.
 */
export async function scanCount(redis: RedisClient, pattern: string): Promise<number> {
  let cursor = 0
  let total = 0

  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
    cursor = result.cursor
    total += result.keys.length
  } while (cursor !== 0)

  return total
}
