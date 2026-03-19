// Shared Redis client for @ibatexas/tools
// Single connection reused across embeddings, query cache, and embedding cache

import { createClient } from "redis"

type RedisClientType = ReturnType<typeof createClient>

// AUDIT-FIX: REDIS-H01 — promise-based mutex prevents TOCTOU race on concurrent getRedisClient() calls
let redis: RedisClientType | null = null
let connectingPromise: Promise<RedisClientType> | null = null

export async function getRedisClient(): Promise<RedisClientType> {
  if (redis?.isOpen) return redis
  if (connectingPromise) return connectingPromise

  connectingPromise = (async () => {
    const redisUrl = process.env.REDIS_URL
    if (!redisUrl) {
      connectingPromise = null
      throw new Error("REDIS_URL env var required")
    }
    const client = createClient({ url: redisUrl })
    // AUDIT-FIX: REDIS-H02 — only log on transient errors; do NOT nullify singleton (fights auto-reconnect)
    client.on("error", (err) => {
      console.error("[Redis] Client error:", (err as Error).message)
    })
    // Only nullify on permanent disconnect ('end' event) so next call reconnects
    client.on("end", () => {
      redis = null
      connectingPromise = null
    })
    await client.connect()
    redis = client
    connectingPromise = null
    return client
  })()

  return connectingPromise
}

export async function closeRedisClient(): Promise<void> {
  if (redis) {
    await redis.quit()
    redis = null
    connectingPromise = null
  }
}
