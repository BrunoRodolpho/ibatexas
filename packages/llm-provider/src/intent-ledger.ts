// Thin adapter wiring @adjudicate/audit's Execution Ledger to IbateXas's
// Redis infrastructure. Keeps the framework package (@adjudicate/audit)
// domain-independent — the Redis client + rk() namespacing lives here.
//
// The ledger is always-on and fail-closed: every adjudication consults
// the ledger for dedup; if Redis is unavailable, the operation throws
// `LedgerUnavailableError`, which the caller surfaces as a refusal.
// This is the correct posture for at-least-once delivery — proceeding
// without dedup risks double-charged orders / duplicate webhooks.

import {
  createRedisLedger,
  type Ledger,
  type LedgerHit,
  type LedgerRecordInput,
  type LedgerRecordOutcome,
} from "@adjudicate/audit"
import { rk, safeRedis } from "@ibatexas/tools"
import { recordLedgerOp } from "@adjudicate/core/kernel"

/**
 * Thrown when the Redis ledger is unavailable. Caller surfaces this as
 * `REFUSE { kind: "SECURITY", code: "ledger_unavailable" }`. Fail-closed
 * by design.
 */
export class LedgerUnavailableError extends Error {
  constructor(public readonly cause?: Error) {
    super("ledger_unavailable")
    this.name = "LedgerUnavailableError"
  }
}

let _ledger: Ledger | null = null

function loadLedger(): Ledger {
  if (_ledger) return _ledger
  const ledger = createRedisLedger({
    client: {
      async set(key, value, options) {
        const result = await safeRedis("critical", async (redis) => {
          if (options === undefined) {
            return (await redis.set(key, value)) as string | null
          }
          const redisOptions: { NX?: true; EX?: number } = {}
          if (options.NX === true) redisOptions.NX = true
          if (typeof options.EX === "number") redisOptions.EX = options.EX
          return (await redis.set(key, value, redisOptions)) as string | null
        })
        return result ?? null
      },
      async get(key) {
        const result = await safeRedis("critical", async (redis) => {
          return await redis.get(key)
        })
        return result ?? null
      },
    },
    keyFor: (suffix) => rk(suffix),
  })
  _ledger = ledger
  return ledger
}

/** @internal — for test isolation. */
export function _resetLedger(): void {
  _ledger = null
}

/**
 * Return the configured Ledger. Always returns a wrapped ledger — every
 * caller MUST consult it before dispatching a mutating intent. On Redis
 * outage the wrapped operations throw `LedgerUnavailableError`.
 */
export async function getIntentLedger(): Promise<Ledger> {
  return wrapWithMetrics(loadLedger())
}

function wrapWithMetrics(inner: Ledger): Ledger {
  return {
    async checkLedger(intentHash: string): Promise<LedgerHit | null> {
      const startedAt = Date.now()
      try {
        const hit = await inner.checkLedger(intentHash)
        recordLedgerOp({
          op: "check",
          outcome: hit ? "hit" : "miss",
          intentKind: "*",
          intentHash,
          latencyMs: Date.now() - startedAt,
        })
        return hit
      } catch (err) {
        recordLedgerOp({
          op: "check",
          outcome: "error",
          intentKind: "*",
          intentHash,
          latencyMs: Date.now() - startedAt,
        })
        throw new LedgerUnavailableError(err as Error)
      }
    },
    async recordExecution(entry: LedgerRecordInput): Promise<LedgerRecordOutcome> {
      const startedAt = Date.now()
      try {
        const outcome = await inner.recordExecution(entry)
        recordLedgerOp({
          op: "record",
          outcome: "ok",
          intentKind: entry.kind,
          intentHash: entry.intentHash,
          latencyMs: Date.now() - startedAt,
        })
        return outcome
      } catch (err) {
        recordLedgerOp({
          op: "record",
          outcome: "error",
          intentKind: entry.kind,
          intentHash: entry.intentHash,
          latencyMs: Date.now() - startedAt,
        })
        throw new LedgerUnavailableError(err as Error)
      }
    },
  }
}
