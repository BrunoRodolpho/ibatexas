// lib/lock.ts — Redis-based scenario lock.
// Prevents concurrent scenario/matrix execution from corrupting state.
// Atomic SET NX EX acquire + ownership-checked Lua release (CLAUDE.md rule #10);
// pattern reference: apps/api/src/whatsapp/session.ts.

import { randomUUID } from "node:crypto"
import { getRedis, rk } from "./redis.js"

const LOCK_KEY = "ibx:scenario:lock"
const LOCK_TTL_SECONDS = 300 // 5 minutes — auto-expire safety net

interface LockInfo {
  scenario: string
  pid: number
  startedAt: string
}

// Stored lock value = LockInfo + a per-acquisition UUID token. The release
// script compares the full stored string, so the token makes each acquisition
// unique and DEL can only fire for the exact holder that wrote it.
interface LockValue extends LockInfo {
  token: string
}

/**
 * Lua script: conditional DEL — only deletes if the lock value matches.
 * Prevents releasing a lock acquired by a different process after our TTL
 * expired or after a --force takeover.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

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

  const value: LockValue = {
    scenario: scenarioName,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  }
  const serialized = JSON.stringify(value)

  if (opts?.force) {
    // Deliberate takeover — overwrite whatever holder exists
    await redis.set(key, serialized, { EX: LOCK_TTL_SECONDS })
  } else {
    // Atomic acquire — NX closes the GET-then-SET TOCTOU window
    const acquired = await redis.set(key, serialized, { NX: true, EX: LOCK_TTL_SECONDS })
    if (acquired !== "OK") {
      const existing = await redis.get(key)
      let info: LockInfo | null = null
      if (existing) {
        try {
          info = JSON.parse(existing) as LockInfo
        } catch {
          // Corrupted lock value — treat as no real holder
        }
      }
      if (info) {
        const elapsed = Math.round((Date.now() - new Date(info.startedAt).getTime()) / 1000)
        throw new Error(
          `Another scenario is running: "${info.scenario}" (PID ${info.pid}, started ${elapsed}s ago)\n` +
          `Use --force to override the lock.`,
        )
      }
      // Corrupted value (or expired between SET and GET) — claim the lock
      await redis.set(key, serialized, { EX: LOCK_TTL_SECONDS })
    }
  }

  // Release: ownership-checked conditional DEL — never plain redis.del()
  return async () => {
    try {
      const redis = await getRedis()
      await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [serialized] })
    } catch {
      // Redis might be disconnected — lock expires via TTL
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
