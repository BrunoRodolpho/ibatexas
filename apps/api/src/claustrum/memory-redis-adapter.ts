// Redis client shim for the @claustrum memory-postgres provider.
//
// ROOT CAUSE (memory recall fail-safe degrade): `createPostgresMemoryProvider`
// is written against an IOREDIS-shaped client — it calls `redis.setex(...)` and
// `redis.pipeline().del(...).exec()`. IbateXas, however, runs node-redis v4
// (the `redis` package, via `getRedisClient()` from `@ibatexas/tools`), whose
// surface is camelCase + different: `setEx` (not `setex`) and `multi` (not
// `pipeline`). The bootstrap previously passed the node-redis client straight in
// behind `as unknown as RedisClientLike`, so on every cache-cold `recall()` the
// write-through `deps.redis.setex(...)` threw `TypeError: setex is not a
// function`. That throw is NOT awaited (`void`), so it surfaces synchronously and
// rejects `recall()`, which the failSafeMemory wrapper swallows into the
// "[memory port degraded (fail-safe): returning empty result]" warn — recall
// returned empty even though episodic WRITES (`observe`'s prisma `$transaction`)
// committed fine.
//
// This adapter bridges the two surfaces at the call boundary (an ibatexas-side
// integration fix — no provider/publish change needed): it exposes exactly the
// ioredis-shaped `RedisClientLike` the provider consumes, delegating to the
// node-redis v4 methods.

import type { RedisClientLike } from "@claustrum/memory-postgres";
import type { getRedisClient } from "@ibatexas/tools";

type MemoryRedisPipeline = ReturnType<RedisClientLike["pipeline"]>;

type NodeRedisClient = Awaited<ReturnType<typeof getRedisClient>>;

/**
 * Wrap a node-redis v4 client in the ioredis-shaped `RedisClientLike` surface the
 * @claustrum memory provider expects. Only the four methods the provider calls
 * (`get`, `setex`, `del`, `pipeline().del().exec()`) are mapped.
 */
export function toMemoryRedisClient(redis: NodeRedisClient): RedisClientLike {
  return {
    get: (key: string): Promise<string | null> =>
      redis.get(key) as Promise<string | null>,
    // ioredis `setex(key, seconds, value)` → node-redis v4 `setEx`.
    setex: (key: string, seconds: number, value: string): Promise<unknown> =>
      redis.setEx(key, seconds, value),
    // node-redis v4 `del` accepts a string[]; the provider spreads keys in.
    del: (...keys: string[]): Promise<number> =>
      keys.length === 0 ? Promise.resolve(0) : redis.del(keys),
    // ioredis `pipeline().del(...).exec()` → batch the DEL fan-out and issue it
    // as a single node-redis `del`. The provider only ever uses the pipeline for
    // cache-key invalidation, so DEL coalescing is behaviour-preserving (no
    // empty-`multi` edge case).
    pipeline: (): MemoryRedisPipeline => {
      const keys: string[] = [];
      const stage: MemoryRedisPipeline = {
        del(...k: string[]): MemoryRedisPipeline {
          keys.push(...k);
          return stage;
        },
        exec: async (): Promise<unknown> => {
          if (keys.length > 0) await redis.del(keys);
          return [];
        },
      };
      return stage;
    },
  };
}
