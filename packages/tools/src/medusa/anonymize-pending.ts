// anonymize-pending.ts — audit-2026-05-24 H3 Wave B.
//
// Redis-backed tracking for in-flight Medusa anonymize compensations.
//
// ── Why this module exists ────────────────────────────────────────────────
//
// The Wave-B subscriber (`customer-anonymize-medusa-resolver`) and the
// Wave-B retry job (`anonymize-medusa-retry`) both need to know which
// `customer.anonymize.medusa.pending` events are still awaiting
// confirmation. Three viable backends:
//
//   1. Redis hash per pending event — simple, low-friction. ← chosen
//   2. Postgres audit-record table query — accurate but slow (full table
//      scan on `kind LIKE 'customer.anonymize.medusa.%'`).
//   3. NATS replay — semantically wrong (events are not durable beyond
//      the in-memory broker).
//
// We pick Redis because it pairs naturally with the existing outbox-retry
// pattern (`apps/api/src/jobs/outbox-retry.ts`) and the anonymize-grace-
// resolver's `anonymize:pending` receipt: both already use Redis as the
// system-of-record for "in-flight destructive op".
//
// ── Key layout ────────────────────────────────────────────────────────────
//
// Per-customer hash key (one entry per outstanding compensation):
//
//   `anonymize:medusa:pending:{customerId}`
//     - JSON-encoded `MedusaAnonymizePendingEntry` (see below)
//     - TTL = MEDUSA_ANONYMIZE_PENDING_TTL_SECONDS (1 week — covers
//       worst-case Medusa outage; auto-GC if everyone forgets about it).
//
// Index of outstanding customer IDs (for the retry job's sweep pass):
//
//   `anonymize:medusa:pending:index` (Redis SET of customerId strings)
//     - SADD on emit-pending.
//     - SREM on confirmed.
//     - On SCAN-fallback when SREM-then-SADD races a confirm, the retry
//       job re-checks the per-customer hash before re-publishing.
//
// Tracking is BEST-EFFORT — if Redis is unreachable when the domain
// service tries to record-pending, the function logs and returns without
// throwing. The subscriber will still run (it consumes the NATS event,
// not the Redis hash); the retry job will simply not find the entry on
// the next sweep — equivalent to "fire-once, no retry". A subsequent
// audit-record query can recover the lost entry if needed.
//
// PII discipline: tracking entries carry (customerId, medusaId,
// parkedIntentHash, parkedAt, firstEmittedAt, attempt). No name / email /
// phone / cpf.

import { getRedisClient } from "../redis/client.js"
import { rk } from "../redis/key.js"

/**
 * 7-day TTL for the per-customer pending hash. Caps unbounded growth if
 * the retry job somehow loses track of an entry; in practice the retry
 * job's `MEDUSA_ANONYMIZE_MAX_ATTEMPTS` cap (12 × 5 min = ~1 h) closes
 * the chain via `exhausted` long before the TTL fires.
 */
export const MEDUSA_ANONYMIZE_PENDING_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Per-customer pending entry. JSON-encoded under
 * `rk('anonymize:medusa:pending:{customerId}')`.
 */
export interface MedusaAnonymizePendingEntry {
  readonly customerId: string
  readonly medusaId: string
  readonly parkedIntentHash: string
  readonly parkedAt: string
  /** Wall-clock ms when the pending event was first emitted. */
  readonly firstEmittedAt: number
  /** 1-based attempt count. Incremented by the retry job on each pass. */
  readonly attempt: number
  /** Wall-clock ms of the most recent attempt. */
  readonly lastAttemptAt: number
}

/** Build the Redis key for a customer's pending entry. */
export function medusaAnonymizePendingKey(customerId: string): string {
  return rk(`anonymize:medusa:pending:${customerId}`)
}

/** Build the Redis key for the set of all customers with pending entries. */
export function medusaAnonymizePendingIndexKey(): string {
  return rk("anonymize:medusa:pending:index")
}

/**
 * Record a pending compensation. Called from `anonymizeCustomer` AFTER
 * the Prisma TX commits.
 *
 * Best-effort — any Redis failure is logged and swallowed; the function
 * does NOT throw. The destructive Prisma op already committed; failing
 * here would surface as a misleading exception up the stack.
 */
export async function recordMedusaAnonymizePending(
  entry: Omit<
    MedusaAnonymizePendingEntry,
    "firstEmittedAt" | "lastAttemptAt"
  > & {
    readonly firstEmittedAt?: number
    readonly lastAttemptAt?: number
  },
  log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  },
): Promise<void> {
  try {
    const redis = await getRedisClient()
    const now = Date.now()
    const full: MedusaAnonymizePendingEntry = {
      ...entry,
      firstEmittedAt: entry.firstEmittedAt ?? now,
      lastAttemptAt: entry.lastAttemptAt ?? now,
    }
    await redis.set(
      medusaAnonymizePendingKey(entry.customerId),
      JSON.stringify(full),
      { EX: MEDUSA_ANONYMIZE_PENDING_TTL_SECONDS },
    )
    await redis.sAdd(medusaAnonymizePendingIndexKey(), entry.customerId)
  } catch (err) {
    log?.error?.(
      "[medusa-anonymize-pending] record failed:",
      (err as Error).message ?? String(err),
    )
  }
}

/** Read a single pending entry by customer id. Returns null if absent. */
export async function readMedusaAnonymizePending(
  customerId: string,
): Promise<MedusaAnonymizePendingEntry | null> {
  try {
    const redis = await getRedisClient()
    const raw = await redis.get(medusaAnonymizePendingKey(customerId))
    if (typeof raw !== "string" || raw.length === 0) return null
    return JSON.parse(raw) as MedusaAnonymizePendingEntry
  } catch {
    return null
  }
}

/**
 * Clear a pending entry after the subscriber confirms a successful
 * Medusa-side scrub. Best-effort.
 */
export async function clearMedusaAnonymizePending(
  customerId: string,
  log?: {
    readonly warn?: (...args: unknown[]) => void
  },
): Promise<void> {
  try {
    const redis = await getRedisClient()
    await redis.del(medusaAnonymizePendingKey(customerId))
    await redis.sRem(medusaAnonymizePendingIndexKey(), customerId)
  } catch (err) {
    log?.warn?.(
      "[medusa-anonymize-pending] clear failed:",
      (err as Error).message ?? String(err),
    )
  }
}

/**
 * Return every outstanding customerId. The retry job iterates over this
 * set on each tick to find candidates for re-publish.
 *
 * Returns an empty array on Redis errors — the next sweep retries.
 */
export async function listMedusaAnonymizePendingCustomerIds(): Promise<
  ReadonlyArray<string>
> {
  try {
    const redis = await getRedisClient()
    const members = await redis.sMembers(medusaAnonymizePendingIndexKey())
    return members
  } catch {
    return []
  }
}

/**
 * Update the attempt counter + lastAttemptAt timestamp. Called by the
 * retry job before re-publishing the pending event so audit consumers
 * can tell which attempt number a `confirmed` / `failed` / `exhausted`
 * record corresponds to.
 *
 * Returns the new attempt number on success, null on failure (Redis
 * down, entry already cleared, etc.).
 */
export async function bumpMedusaAnonymizePendingAttempt(
  customerId: string,
): Promise<MedusaAnonymizePendingEntry | null> {
  try {
    const redis = await getRedisClient()
    const key = medusaAnonymizePendingKey(customerId)
    const raw = await redis.get(key)
    if (typeof raw !== "string" || raw.length === 0) return null
    const entry = JSON.parse(raw) as MedusaAnonymizePendingEntry
    const next: MedusaAnonymizePendingEntry = {
      ...entry,
      attempt: entry.attempt + 1,
      lastAttemptAt: Date.now(),
    }
    await redis.set(key, JSON.stringify(next), {
      EX: MEDUSA_ANONYMIZE_PENDING_TTL_SECONDS,
    })
    return next
  } catch {
    return null
  }
}
