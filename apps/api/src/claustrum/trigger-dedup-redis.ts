// F-21 (class rollout) — the composition root for the agent trigger-dedup
// Redis surface.
//
// # Why this file exists
//
// `processTriggerJob`'s catch path releases the in-flight redelivery + cooldown
// claims. Before F-21 it released them with a plain `del`, which destroys
// whatever is at those keys NOW — including a LATER delivery's live claim, once
// this invocation's own claim has lapsed. The fix is a UUID claim token plus an
// ownership-conditional release, so `TriggerDedupRedis` grew a REQUIRED
// `compareAndDelete` member.
//
// A required member on an interface is only worth the ink if something proves
// the real client can honour it. Here that was actively NOT the case:
//
//     managed-agent-plane.ts:187
//         redis: deps.redis as unknown as TriggerDedupRedis,
//
// `deps.redis` is a `RedisLedgerClient` — and not merely a narrower TYPE of the
// node-redis client, but a distinct object literal built by
// `buildLedgerClient()` in claustrum-bootstrap.ts carrying exactly `set`, `get`
// and `del`. It has no `eval` at runtime, so a `compareAndDelete` added to the
// interface behind that `as unknown as` would have type-checked, shipped, and
// thrown `TypeError: r.eval is not a function` on the first failed agent turn.
// The cast was the fail-OPEN seam; deleting it is half the fix.
//
// # The F-22 precedent, and where this deliberately differs
//
// F-22 (PR #519) established the shape: a composition root takes a raw client,
// PROVES it can serve the path, and returns a surface whose atomicity members
// are REQUIRED rather than optional — `createParkRedisCapabilities` +
// `ParkRedisCapabilities`. This file is the same policy at the same seam type.
//
// It differs in ONE respect, on purpose. `createParkRedisCapabilities` takes
// `client: unknown` and proves the commands with runtime `typeof` probes,
// because its callers genuinely hand it an untyped value. This factory's caller
// (claustrum-bootstrap.ts) has the node-redis client in scope, fully typed, so
// the proof is available at COMPILE time and the parameter is typed
// {@link TriggerDedupRedisSource} instead. That is strictly stronger than a
// runtime probe — the failure lands on the author, not on a 3am pager — and it
// keeps `ALLOWED_CAPABILITY_PROBE` in
// `__tests__/bypass-detection/redis-capability-detect-conformance.test.ts` at
// its one entry, since this file contains no probe to allowlist. F-22's own
// header names the goal as "capabilities are validated at composition root";
// a typed parameter validates them there without a branch existing at all.
//
// The signature is also the repo's injected-first-parameter idiom
// (`atomicIncr(redis, key, ttl)` in `packages/tools/src/redis/atomic-rate-limit.ts`).

import type { TriggerDedupRedis } from "./agent-trigger-bridge.js"

/**
 * Compare-and-delete. Deletes `KEYS[1]` only while its value is still
 * `ARGV[1]`, so a release can never erase a claim another delivery has since
 * made. CLAUDE.md Hard Rule #10; the same script as
 * `packages/tools/src/redis/distributed-lock.ts` `RELEASE_LOCK_SCRIPT` and
 * `adapters/park-redis-capabilities.ts` `COMPARE_AND_DELETE_SCRIPT`.
 */
export const TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

/**
 * The raw client shape this module composes over.
 *
 * Two commands, both genuinely ISSUED (the R5-S12 fail-closed Pick analysis):
 * `set` for the NX claims and the promotes, `eval` for the conditional release.
 * `del` is deliberately absent — after F-21 nothing on this path deletes a
 * claim unconditionally, and a client offering only `del` must not type-check.
 *
 * node-redis's `RedisClientType` satisfies this, which is what makes
 * `createTriggerDedupRedis(await getRedisClient())` compile at the bootstrap
 * and `createTriggerDedupRedis(buildLedgerClient(redis))` NOT compile.
 */
export interface TriggerDedupRedisSource {
  set(
    key: string,
    value: string,
    options: { EX?: number; NX?: true },
  ): Promise<string | null>
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>
}

/**
 * Compose the trigger-dedup Redis surface over a capable client.
 *
 * The ONE place that turns "a Redis client" into "a Redis surface proven able
 * to serve the agent trigger dedup path". Every production trigger call site
 * goes through this.
 */
export function createTriggerDedupRedis(
  client: TriggerDedupRedisSource,
): TriggerDedupRedis {
  return {
    set: (key, value, opts) => client.set(key, value, opts),
    async compareAndDelete(key, expectedValue) {
      const raw = await client.eval(TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT, {
        keys: [key],
        arguments: [expectedValue],
      })
      return Number(raw)
    },
  }
}
