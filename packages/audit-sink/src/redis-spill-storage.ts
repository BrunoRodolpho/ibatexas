// Redis-backed PersistentSpillStorage — Task 19 (M4 Audit & observability).
//
// `persistentBufferedSink` (from `@adjudicate/audit`) needs a durable backing
// store so audit records survive a process restart when an inner sink (NATS,
// Postgres) is temporarily down. The framework ships an in-memory
// implementation that's lossy on restart; this module is the IbateXas-
// production-grade adapter.
//
// Design choices:
//   - Backed by a Redis list `rk("audit:spill:queue")`. RPUSH on append,
//     LPOP on read — strict FIFO ordering matches the framework contract.
//   - 7-day TTL via EXPIRE on every append. A 7-day backlog of audit records
//     is enough for any plausible inner-sink outage; older records would be
//     replayable from the NATS subject `ibatexas.audit.intent.decision.v1`
//     via the redundancy consumer (`audit-consumer.ts`).
//   - `readAll()` returns an async iterable that lazily LPOPs one record at
//     a time so an unbounded backlog never materialises in process memory.
//   - `ack()` is a no-op because the FIFO LPOP semantics already pop the
//     record on read. The framework's drain loop calls `readAll()` then
//     `ack()` per record; our `readAll()` is destructive-by-design.
//
// Failure modes:
//   - Redis unreachable on `append`: throws — the buffered sink falls back to
//     in-memory queue and the `onOverflow` telemetry hook fires.
//   - Redis unreachable on `readAll`: yields zero records; the buffered sink
//     proceeds to its in-memory queue, leaving the durable backlog intact for
//     the next drain attempt.
//   - JSON parse failure on a stored record: the record is dropped and a
//     warning is emitted. We never throw mid-drain because that would block
//     the rest of the backlog from clearing.
//
// CLAUDE.md rule #7: all keys go through `rk()`.
//
// ── Leaf-purity note (claustrum-on-dev WS1) ────────────────────────────────
//
// `@ibatexas/audit-sink` is a LEAF package with ZERO runtime deps on
// `@ibatexas/tools` / `@ibatexas/domain` / `@ibatexas/nats-client` (it was
// extracted to break a `tools → llm-provider → tools` cycle). When this
// adapter moved here from `@ibatexas/llm-provider`, importing `rk` from
// `@ibatexas/tools` would have re-introduced that exact runtime dep. The
// `rk()` helper is a one-liner (`${APP_ENV}:${key}`), so it is inlined
// below to preserve the leaf invariant.
//
// The invariant is one-directional and cannot be relaxed even for tests:
// `@ibatexas/tools` DEPENDS on `@ibatexas/audit-sink` (`packages/tools/
// package.json`), so declaring `@ibatexas/tools` here — as a devDependency
// too — is a hard cycle. Measured (F-23): `turbo build` refuses with
// "Cyclic dependency detected: @ibatexas/tools#build,
// @ibatexas/audit-sink#build". The copy below therefore cannot be
// cross-checked against the canonical `rk` by import from anywhere in this
// package; its agreement is pinned as a PROPERTY instead — see
// `__tests__/redis-spill-storage.test.ts` ("reads APP_ENV at CALL time").
//
// ── What "the same as canonical" means here (F-23) ─────────────────────────
//
// This copy is a semantic mirror of the FUNCTION in
// `packages/tools/src/redis/key.ts`, NOT a byte copy of that FILE. The
// header used to claim byte-identity; it was false in two ways, and one of
// them was a live defect. Stated precisely, so the claim is checkable:
//
//   MIRRORED (must not drift) — the function body: the `APP_ENV` read
//   happens at CALL time, and the fallback is `"development"`. Reading at
//   call time is not a stylistic choice: a module-level capture is the
//   exact pattern FE-D26 abolished, because out-of-process tooling (the
//   ibx CLI's dotenv preload / the journeys harness's `loadTestEnv()`) sets
//   APP_ENV AFTER the module graph is evaluated, so a frozen prefix made
//   the CLI write `development:`-keys while the api read `test:`-keys
//   (invisible seeded carts, phantom counter reset). This file DID capture
//   at module load until F-23; it does not any more.
//
//   DELIBERATELY NOT MIRRORED — the canonical module's import-time
//   fail-fast (`NODE_ENV === "production" && !APP_ENV` ⇒ throw). Rationale,
//   measured rather than assumed: that guard is process-wide, and no
//   process can load this leaf without also arming it. `@ibatexas/audit-
//   sink` has exactly two DIRECT dependents in the workspace —
//   `@ibatexas/tools` and `apps/api` — so every transitive consumer reaches
//   this leaf through one of them, and both put the `@ibatexas/tools`
//   barrel in the same process. That barrel re-exports `./redis/key.js`, so
//   the guard is evaluated during module-graph evaluation, before any spill
//   key can be built. Verified on the built graph: from
//   `apps/api/dist/index.js` the guard is a depth-1 static import; from
//   `packages/cli/dist/index.js` (a transitive consumer, and the one
//   process with the FE-D26 late-APP_ENV shape) it is reached via the same
//   barrel. Duplicating the throw here would add no
//   coverage and would give a leaf whose whole value is being inert at
//   import the power to abort a process. That premise is not left to this
//   comment: `__tests__/leaf-purity-guard-reachability.test.ts` fails the
//   day a package depends on `@ibatexas/audit-sink` without `@ibatexas/
//   tools` in its dependency closure — i.e. the day this paragraph stops
//   being true and the guard must be reconsidered.

import type { AuditRecord } from "@adjudicate/core"
import type { PersistentSpillStorage } from "@adjudicate/audit"

// Inlined from `@ibatexas/tools` (`redis/key.ts`) to keep the leaf pure —
// see the leaf-purity note above. Prepends `${APP_ENV}:` to prevent
// cross-environment key bleed when staging/production share a Redis
// instance. APP_ENV falls back to "development" so local runs work
// without extra config.
//
// APP_ENV is read at CALL time, never captured at module import (FE-D26) —
// mirroring `packages/tools/src/redis/key.ts` exactly. Whenever APP_ENV is
// stable (set before the first call, which is every real deployment), this
// returns the identical string a module-load capture would have.
function rk(key: string): string {
  const envPrefix = process.env.APP_ENV ?? "development"
  return `${envPrefix}:${key}`
}

/**
 * Minimal Redis client interface — accepts node-redis v4 clients (the IbateXas
 * default via `getRedisClient`) and any compatible mock. Narrow on purpose so
 * tests can pass a tiny in-memory stub without faking the full surface.
 */
export interface RedisListClient {
  rPush(key: string, value: string): Promise<number>
  lPop(key: string): Promise<string | null>
  lLen(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

export interface RedisSpillStorageOptions {
  /** Connected Redis client (e.g. from `getRedisClient()`). */
  readonly redis: RedisListClient
  /**
   * Key prefix under which the spill list lives. The final Redis key is
   * `rk(`${keyPrefix}:queue`)` — env-prefixed by `rk()`.
   *
   * Default: `"audit:spill"`.
   */
  readonly keyPrefix?: string
  /**
   * TTL (seconds) applied to the spill list on every append. Reset on each
   * push so a steady stream of spills keeps the list alive; a quiet period
   * lets Redis evict the backlog naturally.
   *
   * Default: 7 days (604_800 seconds).
   */
  readonly ttlSeconds?: number
  /**
   * Optional warn sink for invalid stored records (JSON parse failure).
   * Defaults to `console.warn`. Tests inject a vi.fn to assert the warning.
   */
  readonly warn?: (msg: string, err?: unknown) => void
}

const DEFAULT_KEY_PREFIX = "audit:spill"
const DEFAULT_TTL_SECONDS = 604_800 // 7 days — matches NATS dedup window.

/**
 * Build a `PersistentSpillStorage` backed by a Redis list. Returned value
 * plugs directly into `persistentBufferedSink({storage, ...})`.
 */
export function createRedisSpillStorage(
  opts: RedisSpillStorageOptions,
): PersistentSpillStorage {
  const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const warn = opts.warn ?? ((m: string, e?: unknown) => console.warn(m, e))
  const queueKey = rk(`${keyPrefix}:queue`)

  return {
    async append(record: AuditRecord): Promise<void> {
      // Serialize the redacted record. The redactor (Task 18) runs OUTSIDE
      // the buffered sink — what arrives here is already PII-free.
      const serialized = JSON.stringify(record)
      await opts.redis.rPush(queueKey, serialized)
      // Reset TTL so an active spill stream keeps the list alive. A failure
      // here is non-fatal (the data is already in Redis) — swallow so a
      // transient EXPIRE error doesn't roll back the append.
      try {
        await opts.redis.expire(queueKey, ttlSeconds)
      } catch (err) {
        warn(
          `[redis-spill-storage] EXPIRE failed for ${queueKey} — backlog may be evicted early`,
          err,
        )
      }
    },

    readAll(): AsyncIterable<AuditRecord> {
      // Lazy LPOP loop. Each iteration pops the head of the list; when the
      // list is empty (LPOP returns null) we stop. The framework's drain
      // loop calls `readAll()` once and iterates until exhaustion.
      const redis = opts.redis
      return (async function* () {
        for (;;) {
          let raw: string | null
          try {
            raw = await redis.lPop(queueKey)
          } catch (err) {
            // Redis went away mid-drain. Stop yielding; the framework will
            // proceed to the in-memory queue and retry the spill on the
            // next successful emit.
            warn(
              `[redis-spill-storage] LPOP failed on ${queueKey} — aborting drain`,
              err,
            )
            return
          }
          if (raw === null) return
          let record: AuditRecord
          try {
            record = JSON.parse(raw) as AuditRecord
          } catch (err) {
            warn(
              `[redis-spill-storage] dropped malformed spill entry on ${queueKey}`,
              err,
            )
            continue
          }
          yield record
        }
      })()
    },

    async ack(_record: AuditRecord): Promise<void> {
      // No-op: LPOP in `readAll()` already removed the record. The
      // framework's ack contract permits this — see
      // `PersistentSpillStorage.ack` JSDoc in @adjudicate/audit.
      // The argument is intentionally unused.
    },
  }
}

/**
 * Read the current spill backlog size. Exposed for `/health` / metric
 * exporters that want to surface "how many records are sitting in the
 * spill queue right now".
 */
export async function getRedisSpillSize(
  opts: Pick<RedisSpillStorageOptions, "redis" | "keyPrefix">,
): Promise<number> {
  const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX
  return opts.redis.lLen(rk(`${keyPrefix}:queue`))
}
