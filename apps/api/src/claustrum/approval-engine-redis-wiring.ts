// Redis-client adaptor for @adjudicate/approval-engine (H2 / ERDS-061).
//
// `createRedisApprovalRegistry` (from @adjudicate/approval-engine) is
// intentionally client-agnostic: it takes a narrow `ApprovalRedisClient`
// (`set`/`get`/`del`/`keys`) so the adopter wires whichever Redis client it
// already runs. This module adapts the ibatexas shared node-redis v4 client
// (`getRedisClient()` from @ibatexas/tools) to that surface.
//
// Mapping notes:
//   - The package's `set(key, value, exSeconds)` is "SET with expiry in
//     SECONDS". node-redis v4 expresses that as `setEx(key, seconds, value)`
//     (NOTE the argument ORDER: seconds before value), so we transpose.
//   - `keys(pattern)` is prefix-scoped enumeration. The package docs say
//     production clients SHOULD back this with SCAN, not the blocking KEYS.
//     We use SCAN to avoid blocking the shared connection used by the rest of
//     the app (cache, sessions, ledger). Bounded by the `keyPrefix` glob the
//     registry passes in.
//
// This adaptor is a thin shim and does NOT swallow errors — the caller (the
// approval-engine bridge) is the fail-open boundary, so a Redis fault here
// surfaces to the bridge's try/catch and is dropped there.

import type { ApprovalRedisClient } from "@adjudicate/approval-engine";
import { getRedisClient } from "@ibatexas/tools";

type IbatexasRedis = Awaited<ReturnType<typeof getRedisClient>>;

/**
 * Adapt the ibatexas node-redis v4 client to the approval-engine's narrow
 * `ApprovalRedisClient` surface. The registry only ever touches keys under its
 * own `keyPrefix`, so this client is safe to back with the shared connection.
 */
export function createApprovalRedisClient(redis: IbatexasRedis): ApprovalRedisClient {
  return {
    async set(key: string, value: string, exSeconds: number): Promise<void> {
      // node-redis v4: setEx(key, seconds, value) — SET with TTL in seconds.
      await redis.setEx(key, exSeconds, value);
    },
    async get(key: string): Promise<string | null> {
      return redis.get(key);
    },
    async del(key: string): Promise<unknown> {
      return redis.del(key);
    },
    async keys(pattern: string): Promise<readonly string[]> {
      // SCAN-backed enumeration (NOT the blocking KEYS) — the prefix bounds it.
      // node-redis v4 `scanIterator` yields one key string per iteration.
      const found: string[] = [];
      for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 256 })) {
        found.push(key);
      }
      return found;
    },
  };
}
