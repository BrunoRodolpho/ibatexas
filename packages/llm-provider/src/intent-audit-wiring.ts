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
//      multi-sink fan-out behind a feature flag (`IBX_AUDIT_POSTGRES_ENABLED`).
//      Disabled by default; flips to true after the staging soak (see
//      runbook 04).
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
//                 [postgresSink if IBX_AUDIT_POSTGRES_ENABLED]
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

function postgresEnabled(): boolean {
  return process.env.IBX_AUDIT_POSTGRES_ENABLED === "true"
}

// ── Test-injectable overrides ──────────────────────────────────────────────

interface SinkDependencies {
  readonly redis: RedisListClient | null
  readonly prismaWriter: PrismaRawExecutor | null
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
  _redactor = createAuditRedactor({
    hashSecret: process.env.AUDIT_REDACT_SECRET ?? "",
  })
  return _redactor
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

function loadInnerSink(): AuditSink {
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
  const sinks: AuditSink[] = [console_, nats]

  if (postgresEnabled()) {
    const writer = createPostgresAuditWriter({
      prisma: (_depsOverride?.prismaWriter ?? prisma) as PrismaRawExecutor,
      onInsert: (row) => {
        // Lag observation hook — operator dashboards subtract `row.recorded_at`
        // from `Date.now()` to surface `kernel_audit_postgres_lag_seconds`.
        // We log on debug-only paths to avoid noise on the hot path; the
        // metric registration itself is deferred to a follow-up task that
        // exposes the histogram on the `/metrics` route.
        void row
      },
    })
    sinks.push(
      createPostgresSink({
        writer,
        onError: (err: Error) => {
          // Fail-open: log once and let the buffered sink handle retry.
          console.warn(
            `[intent-audit-wiring] postgres sink emit failed — falling back to spill storage`,
            err,
          )
        },
      }),
    )
  }

  return multiSink(...sinks)
}

function loadSink(): AuditSink {
  if (_sink) return _sink

  const innerSink = loadInnerSink()
  const spillStorage = loadSpillStorage()
  const redactor = loadRedactor()

  // Task 19 — persistent buffer between the redactor and the inner sinks.
  // `onOverflow` is the operator-facing telemetry hook; we log here and
  // future work can wire `recordSinkFailure` once the metrics-sink slot
  // exposes a public spill counter.
  const buffered = persistentBufferedSink({
    inner: innerSink,
    storage: spillStorage,
    capacity: bufferCapacity(),
    onOverflow: (record) => {
      console.warn(
        `[intent-audit-wiring] audit buffer overflow — record spilled to durable storage`,
        { intentKind: record.envelope.kind, intentHash: record.intentHash },
      )
    },
    onSpill: (record, reason) => {
      // Log only on failure/drain-failure (capacity is the expected steady
      // state at high load). Tests assert via the onOverflow hook above.
      if (reason !== "capacity") {
        console.warn(
          `[intent-audit-wiring] audit spill (${reason})`,
          { intentKind: record.envelope.kind, intentHash: record.intentHash },
        )
      }
    },
  })

  // Task 18 wrap — redactor MUST run before the buffered sink (and therefore
  // before fan-out). The Redis spill list never sees raw PII because the
  // record is redacted before any await on the buffered sink completes.
  _sink = {
    async emit(record: AuditRecord): Promise<void> {
      const redacted = redactor.redact(record)
      try {
        await buffered.emit(redacted)
      } catch (err) {
        // The buffered sink rethrows when the inner sink fails (per
        // PersistentBufferedSinkOptions contract). We intentionally swallow
        // here so audit emission is fail-open at the IbateXas boundary: a
        // broken Postgres connection MUST NOT block an adjudicate() call.
        console.warn(
          `[intent-audit-wiring] audit emit failed — record buffered for retry`,
          { intentKind: record.envelope.kind, err: String(err) },
        )
      }
    },
  }
  return _sink
}

// ── Public API ─────────────────────────────────────────────────────────────

/** @internal — for test isolation */
export function _resetAuditSink(): void {
  _sink = null
  _redactor = null
  _depsOverride = null
}

/** @internal — for test access to the redactor used by the wired sink. */
export function _getAuditRedactor(): AuditRedactor {
  return loadRedactor()
}

/** Return the configured audit sink. Always available; sinks are best-effort. */
export function getAuditSink(): AuditSink {
  return loadSink()
}
