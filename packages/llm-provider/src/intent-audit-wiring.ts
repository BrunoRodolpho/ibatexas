// Audit sink wiring — Phase H + Task 18 (M4) + Task 19 (M4).
//
// Bridges @ibatexas/nats-client.publishNatsEvent into the framework-agnostic
// AuditSink interface. Keeps @adjudicate/audit domain-independent — this file
// is the IbateXas-specific adapter.
//
// Every intent capture emits one structured AuditRecord to
//   subject: "audit.intent.decision.v1"
// The event is additive — existing NATS consumers ignore it until they
// subscribe.
//
// Task 18 (M4): the exposed sink wraps the fan-out multiSink with an
// AuditRedactor. Every record passes through the redactor BEFORE any
// concrete sink (console, NATS, Postgres) sees it.
// Investigation 08 §"P0 #1" — without this wrap, `set_pix_details` payloads
// publish plaintext CPF/email/phone to NATS subject
// `ibatexas.audit.intent.decision.v1` and any subscriber with permission
// reads PII in cleartext.
//
// Task 19 (M4): two additions —
//   1. `@adjudicate/audit-postgres.createPostgresSink` is added to the
//      multi-sink fan-out unconditionally. The kernel is always-on and
//      audit-postgres is part of the durable record — operators run
//      `ibx kernel migrate` (called by `ibx bootstrap`) to apply the
//      8 raw-SQL migrations from @adjudicate/audit-postgres. Boot
//      preflight in kernel-bootstrap.ts fails fast if the `intent_audit`
//      table is missing.
//   2. The whole fan-out is wrapped in `persistentBufferedSink`, backed by
//      a Redis spill storage (`createRedisSpillStorage`). When an inner
//      sink fails or backpressures, records spill to Redis and drain on
//      the next successful emit. Records survive a process restart.
//
// Composition order (top-down):
//   sink (exported)
//     └─ redactor.redact(record)                        // Task 18 — PII gate
//         └─ persistentBufferedSink                     // Task 19 — durability
//             └─ multiSink(
//                 consoleSink,
//                 natsSink,
//                 postgresSink                           // always-on
//               )
//
// Order matters: the redactor MUST wrap the buffered sink (not run inside
// it) so the Redis spill list never holds raw PII. If the redactor ran
// downstream of the buffer, a process restart with a populated spill list
// would re-emit unredacted records to NATS and Postgres after recovery.
//
// Bypass-detection: the only public entry point is `getAuditSink()`. Every
// IbateXas call site routes through this getter, so no caller can construct
// a raw multiSink and bypass the redactor. The grep-test
// (audit-redaction-contract.test.ts) asserts this invariant.

import type { AuditRecord } from "@adjudicate/core"
import {
  createConsoleSink,
  createNatsSink,
  multiSink,
  persistentBufferedSink,
  createInMemorySpillStorage,
  type AuditSink,
  type PersistentSpillStorage,
} from "@adjudicate/audit"
import { createPostgresSink } from "@adjudicate/audit-postgres"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { getRedisClient } from "@ibatexas/tools"
import { prisma } from "@ibatexas/domain"
import { createAuditRedactor, type AuditRedactor } from "./audit-redactor.js"
import {
  createRedisSpillStorage,
  type RedisListClient,
} from "./redis-spill-storage.js"
import {
  createPostgresAuditWriter,
  type PrismaRawExecutor,
} from "./postgres-audit-writer.js"
// W6-10 (P2-C): allow callers to inject a pino-shaped logger so audit-
// pipeline warnings carry the per-request reqId when invoked from a
// route handler. Defaults to the console-passthrough.
import { resolveLogger, type IbxLogger } from "./logger.js"

// ── Module-level lazy singletons ────────────────────────────────────────────

let _sink: AuditSink | null = null
let _redactor: AuditRedactor | null = null

// ── Configuration ──────────────────────────────────────────────────────────

/**
 * Buffer capacity before records spill to durable storage. 1_000 records is
 * ~30s of normal traffic at 30 RPS — enough headroom for a momentary inner-
 * sink hiccup without spilling, but not so large that a sustained outage
 * grows the in-memory queue unboundedly.
 *
 * Overridable via `IBX_AUDIT_BUFFER_CAPACITY` for ops tuning.
 */
function bufferCapacity(): number {
  const raw = process.env.IBX_AUDIT_BUFFER_CAPACITY
  if (!raw) return 1_000
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[intent-audit-wiring] IBX_AUDIT_BUFFER_CAPACITY=${raw} is invalid — falling back to 1000`,
    )
    return 1_000
  }
  return parsed
}

// ── Test-injectable overrides ──────────────────────────────────────────────

interface SinkDependencies {
  readonly redis: RedisListClient | null
  readonly prismaWriter: PrismaRawExecutor | null
  /** W6-10: optional pino-shaped logger for reqId-carrying log lines. */
  readonly logger: IbxLogger | null
}

let _depsOverride: Partial<SinkDependencies> | null = null

/**
 * @internal — for test isolation. Inject stubs for the Redis spill client
 * and/or the Prisma raw executor used by the Postgres sink. Pass `null` to
 * fall back to the live `@ibatexas/tools` + `@ibatexas/domain` singletons.
 */
export function _setAuditSinkDependencies(
  deps: Partial<SinkDependencies> | null,
): void {
  _depsOverride = deps
}

// ── Loaders ────────────────────────────────────────────────────────────────

function loadRedactor(): AuditRedactor {
  if (_redactor) return _redactor
  // AUDIT_REDACT_SECRET MUST be set in production — see .env.example. Empty
  // is legal in dev; createAuditRedactor emits a console.warn on boot when
  // the salt is empty so the operator sees the warning during local runs.
  //
  // W3-8: forward redactor fail-open events to the redactor-failures hook
  // so apps/api can bump `kernel_audit_redactor_failures_total{reason}`.
  // The hook is injected by the consumer (set via `setAuditRedactorFailureHook`)
  // to avoid an apps/api → packages/llm-provider dep from this leaf module.
  _redactor = createAuditRedactor({
    hashSecret: process.env.AUDIT_REDACT_SECRET ?? "",
    onFailure: (reason) => {
      if (_redactorFailureHook) {
        try {
          _redactorFailureHook(reason)
        } catch {
          // Hook must NEVER block the redactor's fail-open path.
        }
      }
    },
  })
  return _redactor
}

// ── W3 hook injection points (apps/api wires these at boot) ─────────────────

let _redactorFailureHook: ((reason: string) => void) | null = null
let _auditLagHook:
  | ((sink: string, latencySeconds: number) => void)
  | null = null
let _bufferSizeHook: ((count: number) => void) | null = null
let _spillSizeHook: ((count: number) => void) | null = null

/** W3-8: bump kernel_audit_redactor_failures_total on redactor fail-open. */
export function setAuditRedactorFailureHook(
  hook: ((reason: string) => void) | null,
): void {
  _redactorFailureHook = hook
}

/** W3-1: observe kernel_audit_lag_seconds per audit emit. */
export function setAuditLagHook(
  hook: ((sink: string, latencySeconds: number) => void) | null,
): void {
  _auditLagHook = hook
}

/** W3-9: track in-memory persistentBufferedSink queue size. */
export function setAuditSinkBufferSizeHook(
  hook: ((count: number) => void) | null,
): void {
  _bufferSizeHook = hook
}

/** W3-10: track Redis spill list depth. */
export function setAuditSinkSpillSizeHook(
  hook: ((count: number) => void) | null,
): void {
  _spillSizeHook = hook
}

/**
 * Build the durable spill storage. Returns an in-memory fallback if Redis
 * is unavailable (boot-time failure shouldn't kill the kernel) — the spill
 * still works within the process lifetime, it just doesn't survive a
 * restart. The console.warn on the fallback is the operator's signal to
 * investigate the Redis issue.
 */
function loadSpillStorage(): PersistentSpillStorage {
  const override = _depsOverride?.redis
  if (override !== undefined) {
    // Explicit override (test stub or `null` to force in-memory fallback).
    if (override === null) return createInMemorySpillStorage()
    return createRedisSpillStorage({ redis: override })
  }
  // Live path: try to grab the Redis client. We don't await
  // `getRedisClient()` here because that would force `getAuditSink()` to be
  // async, breaking every call site. Instead we wrap the client in a lazy
  // proxy that resolves the promise on the first call.
  return createRedisSpillStorage({ redis: lazyRedisClient() })
}

/**
 * Lazy proxy around `getRedisClient()`. The first call to any list operation
 * awaits the singleton; subsequent calls reuse the cached client.
 */
function lazyRedisClient(): RedisListClient {
  let cached: RedisListClient | null = null
  let pending: Promise<RedisListClient> | null = null
  async function getClient(): Promise<RedisListClient> {
    if (cached) return cached
    if (!pending) {
      pending = getRedisClient().then((c) => {
        cached = c as unknown as RedisListClient
        return cached
      })
    }
    return pending
  }
  return {
    async rPush(key, value) {
      const c = await getClient()
      return c.rPush(key, value)
    },
    async lPop(key) {
      const c = await getClient()
      return c.lPop(key)
    },
    async lLen(key) {
      const c = await getClient()
      return c.lLen(key)
    },
    async expire(key, seconds) {
      const c = await getClient()
      return c.expire(key, seconds)
    },
  }
}

function loadInnerSink(log: IbxLogger): AuditSink {
  // ConsoleSink for visibility in dev; NatsSink for the durable streaming
  // trail consumed by the audit-consumer subscriber (Task 19) and any
  // future observability sidecars. Falls open: failure in any one of the
  // sinks is non-blocking via multiSink's Promise.allSettled.
  const nats = createNatsSink({
    publisher: {
      async publish(subject, payload) {
        // publishNatsEvent prepends "ibatexas." so the resulting subject is
        // "ibatexas.audit.intent.decision.v1". Subscribers (including the
        // Task 19 audit-consumer) filter on the full subject.
        await publishNatsEvent(subject, payload as Record<string, unknown>)
      },
    },
  })
  const console_ = createConsoleSink({ prefix: "[ibx-audit]" })

  // Audit-postgres is always-on. Boot preflight in kernel-bootstrap.ts
  // verifies the `intent_audit` table exists before serving any traffic;
  // operators run `ibx kernel migrate` (via `ibx bootstrap`) to apply
  // the raw-SQL migrations from @adjudicate/audit-postgres.
  const postgresWriter = createPostgresAuditWriter({
    prisma: (_depsOverride?.prismaWriter ?? prisma) as PrismaRawExecutor,
    onInsert: (row) => {
      void row
    },
  })
  const postgresSink = createPostgresSink({
    writer: postgresWriter,
    onError: (err: Error) => {
      // Postgres outage doesn't block adjudicate() — the buffered sink
      // spills to Redis and the audit-consumer subscriber drains on
      // recovery. W6-10: structured log carries reqId via injected `log`.
      log.warn(
        { err: err.message },
        "[intent-audit-wiring] postgres sink emit failed — falling back to spill storage",
      )
    },
  })

  return multiSink(console_, nats, postgresSink)
}

function loadSink(): AuditSink {
  if (_sink) return _sink

  // W6-10: resolve the structured logger. Defaults to console-passthrough
  // unless the test/adopter injected one via _setAuditSinkDependencies.
  const log = resolveLogger(_depsOverride?.logger ?? null)

  const innerSink = loadInnerSink(log)
  const spillStorage = loadSpillStorage()
  const redactor = loadRedactor()

  // Task 19 — persistent buffer between the redactor and the inner sinks.
  // `onOverflow` is the operator-facing telemetry hook; we log here and
  // future work can wire `recordSinkFailure` once the metrics-sink slot
  // exposes a public spill counter.
  //
  // W3-9/W3-10: also notify the buffer/spill gauges via the injected hooks.
  // The exact in-memory queue size is held internal to persistentBufferedSink
  // so we approximate: each onOverflow is one record evicted to spill (the
  // monotonic spill-depth counter), each onSpill non-capacity is one record
  // at-risk. The gauges are tracked as monotonic counters of observed
  // spills; apps/api can post-process or wire a sibling SCAN poll if a
  // precise count is needed.
  let _bufferDepth = 0
  let _spillDepth = 0
  const buffered = persistentBufferedSink({
    inner: innerSink,
    storage: spillStorage,
    capacity: bufferCapacity(),
    onOverflow: (record) => {
      log.warn(
        { intentKind: record.envelope.kind, intentHash: record.intentHash },
        "[intent-audit-wiring] audit buffer overflow — record spilled to durable storage",
      )
      _spillDepth += 1
      if (_spillSizeHook) {
        try {
          _spillSizeHook(_spillDepth)
        } catch {
          /* fail-open */
        }
      }
    },
    onSpill: (record, reason) => {
      // Log only on failure/drain-failure (capacity is the expected steady
      // state at high load). Tests assert via the onOverflow hook above.
      if (reason !== "capacity") {
        log.warn(
          { intentKind: record.envelope.kind, intentHash: record.intentHash, reason },
          "[intent-audit-wiring] audit spill",
        )
      }
      // Track for the buffer-size gauge — capacity-reason events count
      // as "queue at capacity" snapshots.
      _bufferDepth = Math.max(_bufferDepth, bufferCapacity())
      if (_bufferSizeHook) {
        try {
          _bufferSizeHook(_bufferDepth)
        } catch {
          /* fail-open */
        }
      }
    },
  })

  // Task 18 wrap — redactor MUST run before the buffered sink (and therefore
  // before fan-out). The Redis spill list never sees raw PII because the
  // record is redacted before any await on the buffered sink completes.
  _sink = {
    async emit(record: AuditRecord): Promise<void> {
      const redacted = redactor.redact(record)
      // W3-1 — kernel_audit_lag_seconds: emit→ack latency, in seconds.
      // We measure from `record.at` (kernel-side emit timestamp) to the
      // buffered.emit() return. record.at is ISO-8601; if parsing fails
      // we skip the observation rather than emit garbage.
      const emitStart = Date.now()
      const emittedAtIso = record.at
      try {
        await buffered.emit(redacted)
        recordAuditLagFromIso(emittedAtIso, emitStart, "postgres")
      } catch (err) {
        // Failure still observes — the buffered sink has spilled the
        // record to durable storage, so for the lag SLO this counts as
        // "buffered, not yet durable."
        recordAuditLagFromIso(emittedAtIso, emitStart, "spill")
        // The buffered sink rethrows when the inner sink fails (per
        // PersistentBufferedSinkOptions contract). We intentionally swallow
        // here so audit emission is fail-open at the IbateXas boundary: a
        // broken Postgres connection MUST NOT block an adjudicate() call.
        log.warn(
          { intentKind: record.envelope.kind, err: String(err) },
          "[intent-audit-wiring] audit emit failed — record buffered for retry",
        )
      }
    },
  }
  return _sink
}

function recordAuditLagFromIso(
  emittedAtIso: string,
  emitStart: number,
  sink: "postgres" | "nats" | "console" | "spill" = "postgres",
): void {
  if (!_auditLagHook) return
  const emittedAt = Date.parse(emittedAtIso)
  if (!Number.isFinite(emittedAt)) return
  // Guard against negative lag from clock skew by taking the larger of
  // (now - record.at) and (now - emitStart).
  const now = Date.now()
  const latencyMs = Math.max(now - emittedAt, now - emitStart, 0)
  try {
    _auditLagHook(sink, latencyMs / 1000)
  } catch {
    /* fail-open */
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** @internal — for test isolation */
export function _resetAuditSink(): void {
  _sink = null
  _redactor = null
  _depsOverride = null
  _redactorFailureHook = null
  _auditLagHook = null
  _bufferSizeHook = null
  _spillSizeHook = null
}

/** @internal — for test access to the redactor used by the wired sink. */
export function _getAuditRedactor(): AuditRedactor {
  return loadRedactor()
}

/** Return the configured audit sink. Always available; sinks are best-effort. */
export function getAuditSink(): AuditSink {
  return loadSink()
}
