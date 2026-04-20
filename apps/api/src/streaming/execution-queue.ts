// Per-session execution queue for web chat.
//
// Replaces the racy isStreamActive() check with a Redis-backed
// distributed lock. Only one agent can run per session at a time.
//
// Design: SET NX with 30s TTL + heartbeat extension every 10s.
// Ownership-safe: stores UUID as lock value, uses Lua conditional
// DEL/EXPIRE to prevent releasing/extending another process's lock.
// Future: upgrade to LPUSH/BRPOP for intent merging.

import { randomUUID } from "node:crypto"
import { getRedisClient, rk } from "@ibatexas/tools"

const LOCK_TTL_SECONDS = 30
const HEARTBEAT_MS = 10_000

/**
 * Lua script: conditional DEL — only deletes if the lock value matches.
 * Prevents releasing a lock that was acquired by a different process after
 * our TTL expired.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

/**
 * Lua script: conditional EXPIRE — only extends TTL if the lock value matches.
 * Prevents extending a lock that was already taken over by another process.
 */
const EXTEND_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`

/** Internal state for active locks: lock value + heartbeat interval. */
interface LockState {
  lockValue: string
  heartbeat: ReturnType<typeof setInterval>
}

const activeLocks = new Map<string, LockState>()

/**
 * Try to acquire the execution lock for a web chat session.
 * Returns true if acquired, false if another agent is already running.
 *
 * Stores a UUID as the lock value for ownership-safe release, and starts
 * a heartbeat that extends the TTL every 10s (ownership-checked via Lua).
 */
export async function acquireWebAgentLock(sessionId: string): Promise<boolean> {
  const redis = await getRedisClient()
  const key = rk(`web:agent:${sessionId}`)
  const lockValue = randomUUID()

  const result = await redis.set(key, lockValue, { NX: true, EX: LOCK_TTL_SECONDS })
  if (result !== "OK") return false

  // Start heartbeat to extend TTL during long LLM calls — ownership-checked
  const heartbeat = setInterval(async () => {
    try {
      await redis.eval(EXTEND_LOCK_SCRIPT, {
        keys: [key],
        arguments: [lockValue, String(LOCK_TTL_SECONDS)],
      })
    } catch {
      // Redis may be down — lock will expire naturally
    }
  }, HEARTBEAT_MS)

  activeLocks.set(sessionId, { lockValue, heartbeat })
  return true
}

/**
 * Release the execution lock for a web chat session.
 * Called in the finally block after agent completes.
 *
 * Clears heartbeat and conditionally deletes Redis key only if the lock
 * value matches (ownership check via Lua script).
 */
export async function releaseWebAgentLock(sessionId: string): Promise<void> {
  const state = activeLocks.get(sessionId)
  if (state) {
    clearInterval(state.heartbeat)
    activeLocks.delete(sessionId)
  }

  try {
    const redis = await getRedisClient()
    const key = rk(`web:agent:${sessionId}`)
    if (state) {
      await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [state.lockValue] })
    } else {
      // Fallback: if no state tracked (shouldn't happen), unconditional DEL
      await redis.del(key)
    }
  } catch {
    // Non-critical — TTL will clean up
  }
}
