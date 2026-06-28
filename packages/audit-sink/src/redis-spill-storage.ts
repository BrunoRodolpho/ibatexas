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
// below to preserve the leaf invariant. It MUST stay byte-identical to
// `packages/tools/src/redis/key.ts` so spill keys land in the same Redis
// namespace the rest of the codebase uses.

import type { AuditRecord } from "@adjudicate/core"
import type { PersistentSpillStorage } from "@adjudicate/audit"

// Inlined from `@ibatexas/tools` (`redis/key.ts`) to keep the leaf pure —
// see the leaf-purity note above. Prepends `${APP_ENV}:` to prevent
// cross-environment key bleed when staging/production share a Redis
// instance. APP_ENV falls back to "development" so local runs work
// without extra config.
const RK_ENV_PREFIX: string = process.env.APP_ENV ?? "development"
function rk(key: string): string {
  return `${RK_ENV_PREFIX}:${key}`
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
