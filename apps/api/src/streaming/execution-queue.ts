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
import { logger } from "../lib/logger.js"

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

  // P3-MEM-HEARTBEAT: if a previous lock state for this session is still tracked
  // (e.g. a prior cycle whose release path didn't run), clear its heartbeat
  // before overwriting the Map entry so the old interval can't leak and keep
  // firing. NX-lock semantics are unchanged — we only reacquired above on a
  // fresh SET NX.
  const existing = activeLocks.get(sessionId)
  if (existing) clearInterval(existing.heartbeat)
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
      // F-21 (class rollout): NO tracked state means NO lockValue, and a
      // lockValue is the only ownership proof this module has. The pre-rollout
      // fallback was an unconditional `redis.del(key)` justified as
      // "shouldn't happen" — but the states that produce it are exactly the
      // states where the key is most likely to belong to SOMEONE ELSE: a
      // process restart (the Map is per-process, the Redis key is not) or a
      // second release for a session whose first release already cleared the
      // entry. In both, the key under `key` may be a DIFFERENT, live cycle's
      // lock, and deleting it lets a concurrent agent run for that session —
      // the precise mutual exclusion this module exists to provide.
      //
      // Per the F-22 ruling's failure direction: with no ownership proof the
      // safe action is to leave the key to its TTL and say so loudly. The cost
      // is bounded — at most LOCK_TTL_SECONDS of a stuck session, and the
      // heartbeat that would extend it past that is gone with the state. A
      // blind DEL's cost is not bounded: it is a concurrent-execution bug.
      logger.warn(
        {
          component: "execution-queue",
          sessionId,
          key,
          ttlSeconds: LOCK_TTL_SECONDS,
        },
        "releaseWebAgentLock: no tracked lock state — leaving the key to its TTL " +
          "rather than issuing an unconditional DEL (F-21: no lockValue, no ownership proof)",
      )
    }
  } catch {
    // Non-critical — TTL will clean up
  }
}
