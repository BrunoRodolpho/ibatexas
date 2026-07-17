// Shared Redis client for @ibatexas/tools
// Single connection reused across embeddings, query cache, and embedding cache

import { createClient } from "redis"

type RedisClientType = ReturnType<typeof createClient>

// Promise-based mutex prevents TOCTOU race on concurrent getRedisClient() calls
let redis: RedisClientType | null = null
let connectingPromise: Promise<RedisClientType> | null = null

// Read a non-negative integer knob from the environment (Hard Rule #3 — never
// hardcode; all timeouts/attempts are env-configurable). Falls back on a
// missing/blank/non-finite/negative value.
function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export async function getRedisClient(): Promise<RedisClientType> {
  if (redis?.isOpen) return redis
  if (connectingPromise) return connectingPromise

  const attempt = (async () => {
    const redisUrl = process.env.REDIS_URL
    if (!redisUrl) {
      throw new Error("REDIS_URL env var required")
    }
    // Connect timeout + bounded reconnect so a Redis stall fails fast instead of
    // hanging callers indefinitely. All knobs are env-configurable (Hard Rule #3).
    const connectTimeout = readIntEnv("REDIS_CONNECT_TIMEOUT_MS", 5_000)
    const maxReconnectAttempts = readIntEnv("REDIS_MAX_RECONNECT_ATTEMPTS", 10)
    const baseReconnectDelay = readIntEnv("REDIS_RECONNECT_BASE_DELAY_MS", 100)
    const maxReconnectDelay = readIntEnv("REDIS_RECONNECT_MAX_DELAY_MS", 3_000)

    const client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout,
        // Bounded exponential backoff, capped + jittered. After maxReconnectAttempts
        // node-redis stops reconnecting so a single caller never hangs; the NEXT
        // getRedisClient() then starts a fresh connection cycle (boundary-level
        // auto-reconnect below), so a transient Redis outage self-heals without a
        // process restart (FE-D20). While disconnected, commands reject and callers
        // keep failing closed exactly as before — reconnect only restores service.
        reconnectStrategy: (retries: number) => {
          if (retries >= maxReconnectAttempts) {
            return new Error("Redis: max reconnect attempts exceeded")
          }
          const backoff = Math.min(
            baseReconnectDelay * 2 ** retries,
            maxReconnectDelay,
          )
          const jitter = Math.floor(Math.random() * baseReconnectDelay)
          const delay = Math.min(backoff + jitter, maxReconnectDelay)
          // Structured, ops-visible reconnect signal (distinguishes "Redis down"
          // from "model down" per the FE-D20 finding).
          console.warn(
            `[Redis] connection lost — reconnect attempt ${
              retries + 1
            }/${maxReconnectAttempts} in ${delay}ms`,
          )
          return delay
        },
      },
    })
    // Only log on transient errors; do NOT nullify singleton (fights auto-reconnect)
    client.on("error", (err) => {
      console.error("[Redis] Client error:", (err as Error).message)
    })
    // Ops-visible signal that service has been restored after a drop.
    client.on("ready", () => {
      console.info("[Redis] connection ready")
    })
    // Drop the singleton on permanent disconnect ('end') so the next call
    // reconnects. Guard against a late 'end' from a superseded client clobbering
    // a freshly-rebuilt singleton.
    client.on("end", () => {
      if (redis === client) redis = null
    })
    await client.connect()
    redis = client
    return client
  })()

  connectingPromise = attempt
  // Fail closed WITHOUT wedging: once the attempt settles, clear the cached
  // in-flight promise. On rejection (Redis unreachable — e.g. a Postgres-disconnect
  // cascade) this is what lets the NEXT getRedisClient() start a fresh attempt
  // instead of returning a permanently-rejected promise forever (the FE-D20 wedge);
  // the caller of this call still sees the rejection and fails closed as today. On
  // success the singleton `redis` short-circuits future calls. Both branches are
  // handled so a rejection never leaks as an unhandled rejection.
  const clearIfCurrent = (): void => {
    if (connectingPromise === attempt) connectingPromise = null
  }
  attempt.then(clearIfCurrent, clearIfCurrent)

  return attempt
}

export async function closeRedisClient(): Promise<void> {
  if (redis) {
    await redis.quit()
    redis = null
    connectingPromise = null
  }
}
