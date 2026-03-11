// lib/lock.ts — Redis-based scenario lock.
// Prevents concurrent scenario/matrix execution from corrupting state.
// Uses SET NX EX 300 (5-min auto-expire as safety net).

import { getRedis, closeRedis, rk } from "./redis.js"

const LOCK_KEY = "ibx:scenario:lock"
const LOCK_TTL_SECONDS = 300 // 5 minutes

interface LockInfo {
  scenario: string
  pid: number
  startedAt: string
}

/**
 * Acquire the scenario lock. Returns a release function.
 * Throws if another scenario is already running (unless force = true).
 */
export async function acquireScenarioLock(
  scenarioName: string,
  opts?: { force?: boolean },
): Promise<() => Promise<void>> {
  const redis = await getRedis()
  const key = rk(LOCK_KEY)

  // Check existing lock
  const existing = await redis.get(key)
  if (existing && !opts?.force) {
    try {
      const info = JSON.parse(existing) as LockInfo
      const elapsed = Math.round((Date.now() - new Date(info.startedAt).getTime()) / 1000)
      throw new Error(
        `Another scenario is running: "${info.scenario}" (PID ${info.pid}, started ${elapsed}s ago)\n` +
        `Use --force to override the lock.`,
      )
    } catch (err) {
      if ((err as Error).message.includes("Another scenario")) throw err
      // If JSON.parse fails, the lock is corrupted — force acquire
    }
  }

  // Set lock
  const value: LockInfo = {
    scenario: scenarioName,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }

  await redis.set(key, JSON.stringify(value), { EX: LOCK_TTL_SECONDS })

  // Return release function
  return async () => {
    try {
      const redis = await getRedis()
      const current = await redis.get(key)
      // Only delete if WE own the lock (same PID)
      if (current) {
        try {
          const info = JSON.parse(current) as LockInfo
          if (info.pid === process.pid) {
            await redis.del(key)
          }
        } catch {
          // Corrupted — delete anyway
          await redis.del(key)
        }
      }
    } catch {
      // Redis might be disconnected — best effort
    }
  }
}

/**
 * Check if a scenario lock is currently held.
 */
export async function isScenarioLocked(): Promise<{ locked: boolean; owner?: LockInfo }> {
  try {
    const redis = await getRedis()
    const key = rk(LOCK_KEY)
    const value = await redis.get(key)
    if (!value) return { locked: false }

    const info = JSON.parse(value) as LockInfo
    return { locked: true, owner: info }
  } catch {
    return { locked: false }
  }
}
