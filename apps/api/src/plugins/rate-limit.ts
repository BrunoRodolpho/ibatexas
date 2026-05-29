import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getRedisClient } from "@ibatexas/tools";

// @fastify/rate-limit's bundled RedisStore is written against the ioredis API
// (it calls `redis.defineCommand("rateLimit", ...)` and a callback-style
// `redis.rateLimit(...)`). This codebase standardises on node-redis v4 (single
// shared connection via getRedisClient()), which has neither method. Rather than
// add a second Redis client library + connection, we hand the plugin a thin shim
// that exposes the `rateLimit` command it expects, backed by the shared node-redis
// client via EVAL. Because the shim already defines `rateLimit`, RedisStore never
// invokes `defineCommand`. This is what makes the limit shared across replicas
// (the whole point of the finding) instead of per-replica in-memory.
//
// Lua is kept identical in spirit to the plugin's own store: INCR the key, set the
// TTL on first hit (or when continuing to exceed), otherwise read the remaining TTL.
const RATE_LIMIT_LUA = `
  local current = redis.call('INCR', KEYS[1])
  local timeWindow = tonumber(ARGV[1])
  local max = tonumber(ARGV[2])
  local continueExceeding = ARGV[3] == 'true'
  if current == 1 or (continueExceeding and current > max) then
    redis.call('PEXPIRE', KEYS[1], timeWindow)
  else
    timeWindow = redis.call('PTTL', KEYS[1])
  end
  return {current, timeWindow}
`;

type StoreCallback = (
  err: Error | null,
  result?: { current: number; ttl: number },
) => void;

// ioredis-shaped shim that RedisStore can drive, backed by the shared node-redis client.
interface RateLimitRedisShim {
  rateLimit(
    key: string,
    timeWindow: number,
    max: number,
    continueExceeding: boolean,
    exponentialBackoff: boolean,
    cb: StoreCallback,
  ): void;
}

function buildRedisShim(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
): RateLimitRedisShim {
  return {
    rateLimit(key, timeWindow, max, continueExceeding, _exponentialBackoff, cb) {
      redis
        .eval(RATE_LIMIT_LUA, {
          keys: [key],
          arguments: [String(timeWindow), String(max), String(continueExceeding)],
        })
        .then((res) => {
          const [current, ttl] = res as [number, number];
          cb(null, { current, ttl });
        })
        .catch((err: unknown) => {
          cb(err instanceof Error ? err : new Error(String(err)));
        });
    },
  };
}

export async function registerRateLimit(server: FastifyInstance): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const maxRequests = process.env.RATE_LIMIT_MAX
    ? Number(process.env.RATE_LIMIT_MAX)
    : isProduction ? 30 : 200;

  // Try to back the limiter with the shared Redis connection so the limit is
  // enforced cluster-wide. If Redis is unavailable at boot, fall back to the
  // in-memory store so the API still starts (degraded: per-replica limiting).
  let redisShim: RateLimitRedisShim | undefined;
  try {
    const redis = await getRedisClient();
    redisShim = buildRedisShim(redis);
  } catch (err) {
    server.log.warn(
      { err: String(err) },
      "[rate-limit] Redis unavailable — falling back to in-memory store (per-replica limiting)",
    );
  }

  await server.register(rateLimit, {
    max: maxRequests,
    timeWindow: "1 minute",
    // Shared store across replicas; undefined => plugin's default in-memory store.
    redis: redisShim,
    // If Redis errors at request time, don't 500 the request — degrade gracefully.
    skipOnError: true,
    // Use IP alone as rate limit key to prevent bypass via sessionId rotation
    keyGenerator(request: FastifyRequest): string {
      return request.ip;
    },
    errorResponseBuilder() {
      return {
        statusCode: 429,
        error: "Too Many Requests",
        message: "Muitas mensagens. Aguarde um momento.",
      };
    },
  });
}
