// Thin adapter wiring @ibx/intent-audit's Execution Ledger to IbateXas's
// Redis infrastructure. Keeps the framework package (@ibx/intent-audit)
// domain-independent — the Redis client + rk() namespacing lives here.
//
// Phase F: shadow writes behind IBX_LEDGER_ENABLED.
// Phase G: enforcement behind IBX_LEDGER_ENFORCE — when true, the kernel
//   consults checkLedger() before dispatching a mutating intent and short-
//   circuits if a fresh execution record exists.
// Phase P0-g: Redis calls now route through `safeRedis("critical", ...)` so
//   ledger outages flow through the existing circuit breaker. When the
//   breaker trips:
//     IBX_LEDGER_FAIL_OPEN=true  → log + return as if no ledger (allow + no dedup)
//     IBX_LEDGER_FAIL_OPEN=false → throw LedgerUnavailableError → caller
//                                  surfaces SECURITY/ledger_unavailable refusal.

import {
  createRedisLedger,
  isLedgerEnabled,
  isLedgerEnforced,
  type Ledger,
  type LedgerHit,
  type LedgerRecordInput,
} from "@ibx/intent-audit"
import { rk, safeRedis } from "@ibatexas/tools"
import { recordLedgerOp } from "./intent-metrics.js"

/**
 * Thrown when the Redis ledger is unavailable AND fail-open is disabled.
 * Caller should surface this as a `REFUSE { kind: "SECURITY", code: "ledger_unavailable" }`.
 */
export class LedgerUnavailableError extends Error {
  constructor(public readonly cause?: Error) {
    super("ledger_unavailable")
    this.name = "LedgerUnavailableError"
  }
}

function isFailOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["IBX_LEDGER_FAIL_OPEN"]
  if (raw === undefined) return false
  const v = raw.toLowerCase().trim()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

let _ledger: Ledger | null = null

function loadLedger(): Ledger {
  if (_ledger) return _ledger
  // The framework adapter expects a (key, value, options) shape. Internally
  // we route the redis client call through safeRedis("critical") — that wraps
  // the call with the existing circuit breaker. On CircuitOpenError, the
  // wrapper rethrows; we translate to LedgerUnavailableError below in the
  // public functions checkLedger / recordExecution.
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
 * Return the configured Ledger only when shadow writes or enforcement is on.
 * Returns `null` when both flags are off — callers simply skip the ledger step.
 *
 * The returned Ledger applies the IBX_LEDGER_FAIL_OPEN env policy on every
 * operation: on CircuitOpenError, fail-open returns null (no dedup); fail-safe
 * throws LedgerUnavailableError so the caller can refuse the intent.
 */
export async function getIntentLedger(): Promise<Ledger | null> {
  if (!isLedgerEnabled() && !isLedgerEnforced()) return null
  const inner = loadLedger()
  return wrapWithFailOpenPolicy(inner)
}

function wrapWithFailOpenPolicy(inner: Ledger): Ledger {
  return {
    async checkLedger(intentHash: string): Promise<LedgerHit | null> {
      const startedAt = Date.now()
      try {
        const hit = await inner.checkLedger(intentHash)
        recordLedgerOp({
          op: "check",
          outcome: hit ? "hit" : "miss",
          intentKind: "*", // caller doesn't pass kind; could be threaded later
          latencyMs: Date.now() - startedAt,
        })
        return hit
      } catch (err) {
        recordLedgerOp({
          op: "check",
          outcome: "error",
          intentKind: "*",
          latencyMs: Date.now() - startedAt,
        })
        if (isFailOpen()) {
          console.warn(
            "[intent-ledger] checkLedger failed; fail-open mode → no dedup:",
            (err as Error).message,
          )
          return null
        }
        throw new LedgerUnavailableError(err as Error)
      }
    },
    async recordExecution(entry: LedgerRecordInput): Promise<void> {
      const startedAt = Date.now()
      try {
        await inner.recordExecution(entry)
        recordLedgerOp({
          op: "record",
          outcome: "ok",
          intentKind: entry.kind,
          latencyMs: Date.now() - startedAt,
        })
      } catch (err) {
        recordLedgerOp({
          op: "record",
          outcome: "error",
          intentKind: entry.kind,
          latencyMs: Date.now() - startedAt,
        })
        if (isFailOpen()) {
          console.warn(
            "[intent-ledger] recordExecution failed; fail-open mode → no dedup record:",
            (err as Error).message,
          )
          return
        }
        throw new LedgerUnavailableError(err as Error)
      }
    },
  }
}

export { isLedgerEnabled, isLedgerEnforced }
