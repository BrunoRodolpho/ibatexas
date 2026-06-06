// anonymize-active-lock.ts — audit-2026-05-24 P0-3.
//
// ## Why this lock exists
//
// Pre-fix race (audit E-1):
//
//   T+24h-ε   :  customer hits POST /api/me/data/cancel-deletion
//                in their browser.
//   T+24h+0   :  the defer-timeout-sweeper publishes
//                `intent.defer.timeout`; `anonymize-grace-resolver`
//                begins running `anonymizeCustomer(customerId)` against
//                Prisma.
//
//   Both transactions race against the same Postgres rows.
//   • The resolver issues an UPDATE that hashes phone, NULLs PII, and
//     scrubs reviews. Whichever TX wins the row-locks wins the data —
//     it is NOT determined by application semantics (cancel-vs-resolve
//     order on the wire), it is determined by Postgres lock-acquisition
//     order.
//   • The cancel handler clears the receipt + cooldown and returns 200
//     "Pedido de exclusão cancelado" — even when the resolver TX wins.
//
//   LGPD Art. 18 violation: the customer's revocation request was
//   acknowledged but not honored.
//
// ## Fix — mutual-exclusion at the application layer
//
// Both sides acquire the same Redis SETNX-based mutex BEFORE doing any
// mutating work. Whoever acquires first wins; the loser short-circuits:
//
//   • If the resolver acquires first, the cancel handler returns 409
//     Conflict with a pt-BR copy explaining the irrevocable point was
//     just crossed.
//   • If the cancel handler acquires first, the resolver exits cleanly
//     with a REFUSE audit record `cancel_won_race`, never touching
//     Prisma.
//
// ## Lock semantics
//
//   key      = rk(`anonymize:active:${customerId}`)        (one row per human)
//   value    = randomUUID() per acquire — never reused      (CLAUDE.md rule #10)
//   TTL      = 60 seconds — outlasts worst-case Prisma TX
//              latency (anonymize touches customer + reviews,
//              ~hundreds of ms in CI / dev; 60s leaves a fat
//              safety margin) but auto-expires on holder crash.
//   release  = Lua conditional DEL — only owner can release
//              (CLAUDE.md rule #10 forbids plain redis.del).
//
// ## Why we do NOT block longer
//
// 60s is intentionally tighter than the worst-case end-to-end resolver
// path (NATS deliver → handler boot → Prisma TX → audit emit), so a
// crashed resolver does not leave the customer permanently uncancellable.
// If the resolver actually takes >60s (catastrophic Prisma stall), the
// cancel side will see the lock expired and acquire — at which point the
// resolver, if it ever lands, will fail to mutate (clearPendingDeletion
// already ran by then; the resolver's own receipt-check guards this).
// The combined safety is: cancel always wins on the wire when the
// resolver is slow OR crashed.

import { randomUUID } from "node:crypto"
import { getRedisClient, rk } from "@ibatexas/tools"

/**
 * TTL for the anonymize-active mutex, in seconds.
 *
 * 60s — outlasts worst-case Prisma TX latency, auto-expires on holder
 * crash. See module header for the trade-off rationale.
 */
export const ANONYMIZE_ACTIVE_LOCK_TTL_SECONDS = 60

/**
 * Lock holder discriminator. Written as the prefix of the lock value so
 * the loser can log WHICH side won the race (resolver vs cancel) without
 * a separate Redis round-trip.
 *
 * Format: `${holder}:${uuid}` — kept human-readable to ease incident
 * forensics. The UUID alone is enough for ownership-safe release; the
 * prefix is metadata.
 */
export type AnonymizeActiveLockHolder = "resolving" | "canceling"

/**
 * Lua script: conditional DEL — only deletes the key if the stored value
 * matches the caller's lock value. Prevents one side accidentally
 * releasing the OTHER side's lock if a stale holder is still in flight
 * after TTL expiry (the legitimate new owner's value would not match
 * the stale caller's recorded value).
 *
 * Mirrors `RELEASE_LOCK_SCRIPT` in `apps/api/src/whatsapp/session.ts`.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

/**
 * Build the Redis key for the anonymize-active mutex on a customer.
 *
 * Exported so tests can inspect the key namespace and assertions can
 * pin the format (`ibatexas:anonymize:active:{customerId}`).
 */
export function anonymizeActiveLockKey(customerId: string): string {
  return rk(`anonymize:active:${customerId}`)
}

/**
 * Result of `acquireAnonymizeActiveLock`.
 *
 * `acquired: true`  — caller holds the lock, MUST call
 *                     `releaseAnonymizeActiveLock(customerId, lockValue)`
 *                     in the finally of its TX (or accept TTL expiry on
 *                     crash).
 * `acquired: false` — another side is mutating right now. Caller MUST
 *                     short-circuit without performing its mutation.
 *                     `heldBy` carries the prefix of the existing holder
 *                     so the caller can produce a meaningful error.
 */
export type AcquireResult =
  | { readonly acquired: true; readonly lockValue: string }
  | {
      readonly acquired: false
      readonly heldBy: AnonymizeActiveLockHolder | "unknown"
    }

/**
 * Attempt to acquire the anonymize-active mutex for a customer.
 *
 * Implementation: atomic `SET key value EX ttl NX` — node-redis returns
 * "OK" on acquire, `null` on collision. On collision we issue a follow-up
 * `GET` to recover the holder discriminator (best-effort — if the holder
 * released between SETNX and GET, we report "unknown").
 *
 * Callers MUST treat any thrown exception as "lock NOT acquired" — the
 * fail-closed default is the customer-safe behavior (don't mutate).
 */
export async function acquireAnonymizeActiveLock(
  customerId: string,
  holder: AnonymizeActiveLockHolder,
): Promise<AcquireResult> {
  const redis = await getRedisClient()
  const key = anonymizeActiveLockKey(customerId)
  const uuid = randomUUID()
  const lockValue = `${holder}:${uuid}`

  // node-redis: { NX: true } returns "OK" on acquire, null on collision.
  const result = await redis.set(key, lockValue, {
    EX: ANONYMIZE_ACTIVE_LOCK_TTL_SECONDS,
    NX: true,
  } as { EX: number })

  if (result === "OK") {
    return { acquired: true, lockValue }
  }

  // Collision — read the existing value so we can tell the caller WHO
  // beat them. Tolerate races: the holder may release between our SETNX
  // and this GET, in which case we report "unknown" (the caller still
  // short-circuits — we do not retry SETNX).
  let heldBy: AnonymizeActiveLockHolder | "unknown" = "unknown"
  try {
    const existing = await redis.get(key)
    if (existing && typeof existing === "string") {
      if (existing.startsWith("resolving:")) heldBy = "resolving"
      else if (existing.startsWith("canceling:")) heldBy = "canceling"
    }
  } catch {
    // Best-effort metadata read — never block the short-circuit on it.
  }

  return { acquired: false, heldBy }
}

/**
 * Conditionally release the anonymize-active mutex.
 *
 * Uses a Lua script (`RELEASE_LOCK_SCRIPT`) that GET-and-DEL only when
 * the stored value matches the caller's `lockValue`. This is the
 * CLAUDE.md rule #10 pattern: a plain `redis.del()` would risk releasing
 * a freshly-acquired lock owned by the OTHER side if our caller's TX ran
 * past the 60s TTL.
 *
 * Errors are swallowed — best-effort release; the TTL is the
 * source-of-truth deadline. The caller must NOT depend on this returning
 * successfully (e.g. don't gate further behavior on the release outcome).
 */
export async function releaseAnonymizeActiveLock(
  customerId: string,
  lockValue: string,
): Promise<void> {
  try {
    const redis = await getRedisClient()
    const key = anonymizeActiveLockKey(customerId)
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
