// Shared Redis client for @ibatexas/tools
// Single connection reused across embeddings, query cache, and embedding cache

import { createClient } from "redis"

type RedisClientType = ReturnType<typeof createClient>

// Promise-based mutex prevents TOCTOU race on concurrent getRedisClient() calls
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
    // Connect timeout + bounded reconnect so a Redis stall fails fast instead of
    // hanging callers indefinitely. All knobs are env-configurable (Hard Rule #3).
    const connectTimeout = process.env.REDIS_CONNECT_TIMEOUT_MS
      ? Number(process.env.REDIS_CONNECT_TIMEOUT_MS)
      : 5_000
    const maxReconnectAttempts = process.env.REDIS_MAX_RECONNECT_ATTEMPTS
      ? Number(process.env.REDIS_MAX_RECONNECT_ATTEMPTS)
      : 10
    const maxReconnectDelay = process.env.REDIS_RECONNECT_MAX_DELAY_MS
      ? Number(process.env.REDIS_RECONNECT_MAX_DELAY_MS)
      : 3_000
    const client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout,
        // Bounded backoff: linear up to maxReconnectDelay; give up after
        // maxReconnectAttempts so callers get a connection error rather than a hang.
        reconnectStrategy: (retries: number) => {
          if (retries >= maxReconnectAttempts) {
            return new Error("Redis: max reconnect attempts exceeded")
          }
          return Math.min((retries + 1) * 200, maxReconnectDelay)
        },
      },
    })
    // Only log on transient errors; do NOT nullify singleton (fights auto-reconnect)
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
