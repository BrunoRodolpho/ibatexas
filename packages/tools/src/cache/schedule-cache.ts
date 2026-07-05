// Redis cache for the restaurant schedule.
// Key: rk("restaurant:schedule") — JSON, bounded TTL (SCHEDULE_CACHE_TTL_SECONDS,
// default 300s). Invalidated on every admin write (PUT/POST/DELETE on schedule
// endpoints) so edits normally propagate instantly. The TTL is the SAFETY FLOOR:
// if an invalidation DEL is swallowed (circuit-open / transient Redis error — see
// safe-redis.ts), the stale snapshot expires after the TTL and the next read
// re-reads the DB, capping how long a wrong schedule fact can be served.

import { createScheduleService, type RestaurantSchedule } from "@ibatexas/domain"
import { rk } from "../redis/key.js"
import { safeRedis } from "../redis/safe-redis.js"

const SCHEDULE_KEY = rk("restaurant:schedule")

const DEFAULT_SCHEDULE_CACHE_TTL_SECONDS = 300

/**
 * Bounded TTL (seconds) for the cached schedule snapshot, read per-call from
 * `SCHEDULE_CACHE_TTL_SECONDS` so it can be tuned without a redeploy. A missing,
 * non-numeric, or non-positive value falls back to the 300s default — the TTL is
 * a staleness FLOOR, so it must never silently degrade to "no expiry".
 */
function scheduleCacheTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.SCHEDULE_CACHE_TTL_SECONDS ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCHEDULE_CACHE_TTL_SECONDS
}

/** Outcome of a schedule-cache invalidation attempt (see {@link invalidateScheduleCache}). */
export interface ScheduleCacheInvalidation {
  /** `false` when the DEL was swallowed (circuit-open / error) even after one retry. */
  readonly ok: boolean
}

/**
 * Read cached schedule from Redis.
 * Returns null on miss, TTL expiry, or circuit-open.
 */
export async function getCachedSchedule(): Promise<RestaurantSchedule | null> {
  const raw = await safeRedis("non-critical", (redis) => redis.get(SCHEDULE_KEY))
  if (!raw) return null
  return JSON.parse(raw) as RestaurantSchedule
}

/**
 * Write schedule to Redis cache with a bounded TTL (SCHEDULE_CACHE_TTL_SECONDS).
 * The TTL caps staleness even if a later invalidation DEL is swallowed.
 */
export async function setCachedSchedule(schedule: RestaurantSchedule): Promise<void> {
  await safeRedis("non-critical", (redis) =>
    redis.set(SCHEDULE_KEY, JSON.stringify(schedule), { EX: scheduleCacheTtlSeconds() }),
  )
}

/**
 * Delete the cached schedule. Call after every admin mutation.
 *
 * Non-critical Redis ops are swallowed by {@link safeRedis} (circuit-open OR a
 * transient error both yield `null`), so a naive DEL can fail silently and leave
 * the stale snapshot serving until the TTL expires. This returns an explicit
 * {@link ScheduleCacheInvalidation} outcome and retries the DEL ONCE before
 * reporting failure, so callers can log that the edit may take up to the TTL to
 * propagate. It never throws — a failed invalidation must NOT fail the admin
 * mutation (the write already succeeded; the TTL bounds the staleness).
 */
export async function invalidateScheduleCache(): Promise<ScheduleCacheInvalidation> {
  const first = await safeRedis("non-critical", (redis) => redis.del(SCHEDULE_KEY))
  if (first !== null) return { ok: true }
  // First attempt was swallowed — retry once (a transient blip may have cleared).
  const second = await safeRedis("non-critical", (redis) => redis.del(SCHEDULE_KEY))
  return { ok: second !== null }
}

/**
 * Read-through: try cache → miss → read DB → populate cache.
 * This is the primary entry point for consumers (agent, prompt synthesizer).
 */
export async function loadSchedule(): Promise<RestaurantSchedule> {
  const cached = await getCachedSchedule()
  if (cached) return cached

  const svc = createScheduleService()
  const schedule = await svc.getFullSchedule()
  await setCachedSchedule(schedule)
  return schedule
}
