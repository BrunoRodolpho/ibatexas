// Redis cache for the site banner text.
// Key: rk("site:banner:text") — plain string, no TTL.
// Updated by admin PUT /api/admin/banner, read by public GET /api/banner/text.

import { rk } from "../redis/key.js"
import { safeRedis } from "../redis/safe-redis.js"

const BANNER_KEY = rk("site:banner:text")

/**
 * Read the current banner text from Redis.
 * Returns null when no banner is configured or circuit is open.
 */
export async function getBannerText(): Promise<string | null> {
  return safeRedis("non-critical", (redis) => redis.get(BANNER_KEY))
}

/**
 * Write banner text to Redis (no TTL — lives until overwritten or cleared).
 */
export async function setBannerText(text: string): Promise<void> {
  await safeRedis("non-critical", (redis) => redis.set(BANNER_KEY, text))
}

/**
 * Delete the banner text. Call when admin clears the banner.
 */
export async function clearBannerText(): Promise<void> {
  await safeRedis("non-critical", (redis) => redis.del(BANNER_KEY))
}
