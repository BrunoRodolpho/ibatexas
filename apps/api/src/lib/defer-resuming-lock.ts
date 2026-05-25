// defer-resuming-lock.ts — audit-2026-05-25 (I7).
//
// ## Why this helper exists
//
// The `defer:resuming:{deferResumeHash}` mutex was added in audit-2026-05-24
// to close the E2 sweeper-vs-resolver race. The pre-fix mutex used a
// metadata-string value (timestamp / JSON blob) and released via plain
// `redis.del(key).catch(() => {})` at 11 sites across two files:
//
//   apps/api/src/jobs/defer-timeout-sweeper.ts  — lines 337, 360, 386, 574,
//                                                  591, 592, 607
//   apps/api/src/subscribers/defer-resolver.ts  — lines 615, 628, 656, 664,
//                                                  689, 814, 853
//
// CLAUDE.md hard rule #10 mandates UUID lock values + Lua conditional
// release. Without ownership-checked release, a stalled holder whose TTL
// expires can later DEL a freshly-acquired lock owned by ANOTHER side,
// reopening the same double-dispatch window the mutex was added to close.
//
// ## What this module provides
//
//   - `acquireDeferResumingLock(key, ttlSeconds, holder)` — SETNX with a
//     UUID-bearing lock value. Returns `{acquired, lockValue}` where the
//     lockValue is the caller-owned token needed for safe release.
//   - `releaseDeferResumingLock(key, lockValue)` — Lua compare-and-delete
//     (mirrors `RELEASE_LOCK_SCRIPT` in apps/api/src/whatsapp/session.ts
//     and routes/me/anonymize-active-lock.ts). Idempotent: a `null`
//     `lockValue` is a no-op (covers the "I didn't acquire, but I still
//     reach the cleanup path" branch).
//
// Sites that need to construct fallback keys (sweeper's
// `defer:resuming:fallback:${sessionId}` branch when intentHash is null)
// keep their key-construction logic and pass the resolved key into
// acquire/release — this helper does NOT own key construction.

import { randomUUID } from "node:crypto"
import { getRedisClient } from "@ibatexas/tools"

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

export type DeferResumingHolder = "sweeper" | "resolver"

export interface AcquireDeferResumingLockResult {
  readonly acquired: boolean
  /** Caller-owned ownership token. `null` when `acquired === false`. */
  readonly lockValue: string | null
}

/**
 * Attempt to acquire a `defer:resuming:*` mutex. Returns the lockValue
 * the caller must pass to `releaseDeferResumingLock` for safe release.
 *
 * The holder discriminator ("sweeper" | "resolver") is the prefix of
 * the lockValue so incident forensics can correlate WHO held the lock
 * without an extra Redis round-trip.
 *
 * Redis errors are caught and surfaced as `acquired: false`. The caller
 * fails closed by treating non-acquired as "another writer is mid-flight,
 * skip my work".
 */
export async function acquireDeferResumingLock(
  key: string,
  ttlSeconds: number,
  holder: DeferResumingHolder,
): Promise<AcquireDeferResumingLockResult> {
  try {
    const redis = await getRedisClient()
    const lockValue = `${holder}:${randomUUID()}`
    const result = await redis.set(key, lockValue, {
      NX: true,
      EX: ttlSeconds,
    } as { NX: true; EX: number })
    if (result === "OK") {
      return { acquired: true, lockValue }
    }
    return { acquired: false, lockValue: null }
  } catch {
    return { acquired: false, lockValue: null }
  }
}

/**
 * Conditionally release a `defer:resuming:*` mutex via Lua compare-and-
 * delete. Only releases when the stored value matches `lockValue` —
 * prevents a stale holder from accidentally releasing a freshly-acquired
 * lock owned by another side.
 *
 * Best-effort: errors are swallowed (TTL is the source-of-truth deadline).
 * Idempotent: a `null` lockValue is a no-op so callers can blindly invoke
 * this in finally-blocks even when acquisition failed.
 */
export async function releaseDeferResumingLock(
  key: string,
  lockValue: string | null,
): Promise<void> {
  if (lockValue === null) return
  try {
    const redis = await getRedisClient()
    await (
      redis as unknown as {
        eval: (
          script: string,
          opts: { keys: string[]; arguments: string[] },
        ) => Promise<unknown>
      }
    ).eval(RELEASE_LOCK_SCRIPT, {
      keys: [key],
      arguments: [lockValue],
    })
  } catch {
    // Best-effort cleanup — lock will expire via TTL.
  }
}
