// Redis cache for the restaurant schedule.
// Key: rk("restaurant:schedule") — JSON, no TTL.
// Invalidated on every admin write (PUT/POST/DELETE on schedule endpoints).

import { createScheduleService, type RestaurantSchedule } from "@ibatexas/domain"
import { rk } from "../redis/key.js"
import { safeRedis } from "../redis/safe-redis.js"

const SCHEDULE_KEY = rk("restaurant:schedule")

/**
 * Read cached schedule from Redis.
 * Returns null on miss or circuit-open.
 */
export async function getCachedSchedule(): Promise<RestaurantSchedule | null> {
  const raw = await safeRedis("non-critical", (redis) => redis.get(SCHEDULE_KEY))
  if (!raw) return null
  return JSON.parse(raw) as RestaurantSchedule
}

/**
 * Write schedule to Redis cache (no TTL — lives until invalidated).
 */
export async function setCachedSchedule(schedule: RestaurantSchedule): Promise<void> {
  await safeRedis("non-critical", (redis) => redis.set(SCHEDULE_KEY, JSON.stringify(schedule)))
}

/**
 * Delete the cached schedule. Call after every admin mutation.
 */
export async function invalidateScheduleCache(): Promise<void> {
  await safeRedis("non-critical", (redis) => redis.del(SCHEDULE_KEY))
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
