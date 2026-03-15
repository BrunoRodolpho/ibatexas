// Shared Redis client for @ibatexas/tools
// Single connection reused across embeddings, query cache, and embedding cache

import { createClient } from "redis"

let redis: ReturnType<typeof createClient> | null = null

export async function getRedisClient(): Promise<ReturnType<typeof createClient>> {
  if (!redis) {
    const redisUrl = process.env.REDIS_URL
    if (!redisUrl) {
      throw new Error("REDIS_URL env var required")
    }
    redis = createClient({ url: redisUrl })
    redis.on("error", (err) => {
      console.error("[Redis] Client error:", err)
      // Clear reference so next call creates a fresh connection
      redis = null
    })
    await redis.connect()
  }
  return redis
}

export async function closeRedisClient(): Promise<void> {
  if (redis) {
    await redis.quit()
    redis = null
  }
}
