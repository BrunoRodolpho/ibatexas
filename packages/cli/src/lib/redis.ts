// lib/redis.ts — shared Redis helpers for CLI commands.
// Extracted from intelligence.ts and test.ts to eliminate duplication.
// Re-exports rk() from @ibatexas/tools so CLI files import from one place.

import chalk from "chalk"

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

// ── Flush helpers (shared by auth and rate commands) ────────────────────────

/**
 * Delete an exact Redis key. Returns 1 if deleted, 0 if not found.
 */
export async function flushExactKey(redis: RedisClient, label: string, key: string, dryRun: boolean): Promise<number> {
  const exists = await redis.exists(key)
  if (!exists) {
    console.log(chalk.gray(`  · ${label}: not set`))
    return 0
  }
  if (dryRun) {
    console.log(chalk.yellow(`  [dry-run] would delete ${label}: ${key}`))
  } else {
    await redis.del(key)
    console.log(chalk.green(`  ✓ deleted ${label}: ${key}`))
  }
  return 1
}

/**
 * Delete all Redis keys matching a glob pattern via SCAN + DEL.
 * Returns the number of keys deleted (or would-be-deleted in dry-run).
 */
export async function flushGlobPattern(redis: RedisClient, label: string, pattern: string, dryRun: boolean): Promise<number> {
  if (dryRun) {
    let cursor = 0
    let count = 0
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
      cursor = result.cursor
      count += result.keys.length
    } while (cursor !== 0)
    if (count > 0) {
      console.log(chalk.yellow(`  [dry-run] would delete ${count} ${label} key(s): ${pattern}`))
    } else {
      console.log(chalk.gray(`  · no ${label} keys found`))
    }
    return count
  }

  const deleted = await scanDelete(redis, pattern)
  if (deleted > 0) {
    console.log(chalk.green(`  ✓ deleted ${deleted} ${label} key(s)`))
  } else {
    console.log(chalk.gray(`  · no ${label} keys found`))
  }
  return deleted
}

/**
 * Print summary after a flush operation.
 */
export function printFlushSummary(totalDeleted: number, dryRun: boolean): void {
  console.log()
  if (totalDeleted === 0) {
    console.log(chalk.gray("  Nothing to flush — all clear.\n"))
  } else if (dryRun) {
    console.log(chalk.yellow(`  [dry-run] ${totalDeleted} key(s) would be deleted. Run without --dry-run to apply.\n`))
  } else {
    console.log(chalk.green(`  ✓ Flushed ${totalDeleted} key(s).\n`))
  }
}

/**
 * Scan for all keys matching a glob pattern. Returns the key strings.
 */
export async function scanKeysForPattern(redis: RedisClient, pattern: string): Promise<string[]> {
  let cursor = 0
  const keys: string[] = []
  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
    cursor = result.cursor
    keys.push(...result.keys)
  } while (cursor !== 0)
  return keys
}
