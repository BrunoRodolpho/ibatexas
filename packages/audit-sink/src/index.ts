// @ibatexas/audit-sink — leaf package that owns the construction of the
// IbateXas audit sink (the value returned by `getAuditSink()`).
//
// ── Why this package exists (audit-2026-05-24 H2 / P0-4) ──────────────────
//
// Pre-H2, `getAuditSink()` lived in `@ibatexas/llm-provider`. The cart-tool
// + WhatsApp-client wrapper-call sites in `@ibatexas/tools` and
// `apps/api/src/whatsapp/client.ts` could not import it without creating
// a `@ibatexas/tools → @ibatexas/llm-provider → @ibatexas/tools` cycle
// (`intent-audit-wiring.ts` pulls `getRedisClient` and `rk` from
// `@ibatexas/tools`). The result: 28 wrapper-call sites threaded NO
// `auditSink` into wrapper meta — fail-open posture meant the audit emit
// silently skipped on every call. The audit-trail hole was the H2
// load-bearing finding.
//
// A1 (boot-time DI). This leaf package has ZERO runtime imports from
// `@ibatexas/tools` / `@ibatexas/domain` / `@ibatexas/nats-client` /
// `@ibatexas/llm-provider`. It only depends on `@adjudicate/*` (registry).
// Dependencies (Redis spill storage, Postgres writer, NATS publisher,
// logger) are injected at app boot via `__setAuditSinkDependencies(...)`.
// `getAuditSink()` is fail-closed: calling it before boot wiring throws.
//
// The wrappers and adapters (`redis-spill-storage.ts`,
// `postgres-audit-writer.ts`, `audit-redactor.ts`) STAY in
// `@ibatexas/llm-provider`. They're called via DI from `apps/api` boot —
// the leaf takes already-constructed adapters as inputs.
//
// ── Composition contract ──────────────────────────────────────────────────
//
// The leaf builds the same composition the pre-H2 wiring produced:
//
//   getAuditSink() = redactor.redact → persistentBufferedSink(
//                      capacity,
//                      storage,                    // injected
//                      multiSink(
//                        consoleSink,
//                        natsSink,                 // wraps injected publisher
//                        postgresSink              // wraps injected writer
//                      )
//                    )
//
// Order matters: the redactor MUST wrap the buffered sink (not run inside
// it) so the Redis spill list never holds raw PII (Task 18 invariant).
//
// ── Boot ordering ────────────────────────────────────────────────────────
//
// `__setAuditSinkDependencies(...)` MUST be called at app boot, AFTER the
// Redis + Prisma + NATS clients are constructed, BEFORE any code path can
// reach `getAuditSink()`. The wrapper-call sites in `@ibatexas/tools`
// (cart tools) and `apps/api/src/whatsapp/client.ts` will throw the
// "audit sink not initialized" error if invoked before the boot wiring.

import {
  createConsoleSink,
  createNatsSink,
  multiSink,
  persistentBufferedSink,
  type AuditSink,
  type PersistentSpillStorage,
} from "@adjudicate/audit"
import { createPostgresSink } from "@adjudicate/audit-postgres"
import type { AuditRecord } from "@adjudicate/core"

// Re-export `AuditSink` so wrapper-call sites can `import type { AuditSink }
// from "@ibatexas/audit-sink"` without reaching into `@adjudicate/audit`
// directly. The interface itself is owned by `@adjudicate/audit` (the
// registry-published leaf); this is a convenience alias, not a redefinition.
export type { AuditSink } from "@adjudicate/audit"

// ── Public injection interfaces ───────────────────────────────────────────

/**
 * Pino-compatible logger surface. Adopters pass `req.log` from fastify or
 * a hand-rolled equivalent. The leaf calls `warn` on Postgres / buffered-
 * sink failures so the operator can correlate audit hiccups with the
 * request that triggered them.
 *
 * Mirrors `IbxLogger` from `@ibatexas/llm-provider/logger.ts` — kept
 * structural to avoid a runtime cross-package import.
 */
export interface AuditSinkLogger {
  warn(obj: Record<string, unknown> | string, msg?: string): void
  error(obj: Record<string, unknown> | string, msg?: string): void
}

/**
 * Redactor surface — the leaf calls `redact(record)` BEFORE handing the
 * record to the buffered sink so the Redis spill list never sees raw PII.
 *
 * Structurally identical to the `AuditRedactor` returned by
 * `createAuditRedactor(...)` from `@ibatexas/llm-provider`. Kept narrow
 * here so the leaf has zero runtime dep on the adopter package.
 */
export interface AuditSinkRedactor {
  redact(record: AuditRecord): AuditRecord
}

/**
 * NATS publisher surface. Wraps `publishNatsEvent` from
 * `@ibatexas/nats-client` — see the IbateXas audit subject convention
 * `ibatexas.audit.intent.decision.v1` (the `ibatexas.` prefix is added by
 * the publisher). The leaf wires this into a `createNatsSink` so every
 * audit record fans out to the NATS subject.
 */
export interface AuditSinkNatsPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>
}

/**
 * Postgres writer surface — wraps `prisma.$executeRawUnsafe` via
 * `createPostgresAuditWriter` from `@ibatexas/llm-provider`. The leaf
 * passes this to `createPostgresSink({writer})` to get the durable
 * `intent_audit` INSERT path.
 */
export interface AuditSinkPostgresWriter {
  insertAudit(row: {
    readonly intent_hash: string
    readonly session_id: string
    readonly kind: string
    readonly principal: string
    readonly taint: string
    readonly decision_kind: string
    readonly refusal_kind: string | null
    readonly refusal_code: string | null
    readonly decision_basis: ReadonlyArray<string>
    readonly resource_version: string | null
    readonly envelope_jsonb: string
    readonly decision_jsonb: string
    readonly recorded_at: string
    readonly duration_ms: number | null
    readonly partition_month: string
    readonly record_version: number
    readonly plan_jsonb: string | null
    readonly nonce: string | null
    readonly supersedes_jsonb: string | null
  }): Promise<void>
}

/**
 * Per-failure observability hook fired by the leaf when a downstream sink
 * errors. Wire to `kernel_audit_sink_failure_total{sink,reason}` in
 * apps/api boot via the existing `setAuditSinkFailureHook` plumbing.
 *
 * The event shape mirrors `@adjudicate/core/kernel`'s SinkFailureEvent —
 * `sink` restricted to the "console" | "nats" | "postgres" enum.
 */
export interface AuditSinkFailureEvent {
  readonly sink: "console" | "nats" | "postgres"
  readonly subject: string
  readonly errorClass: string
  readonly consecutiveFailures: number
}

/**
 * Per-failure observability hook fired on Postgres `ON CONFLICT DO NOTHING`
 * no-ops. Used by apps/api to bump `kernel_audit_dedup_total{path="in_process"}`
 * — see `setAuditDedupHook` in `@ibatexas/llm-provider`.
 */
export type AuditSinkDedupHook = (path: "in_process" | "consumer") => void

/**
 * Per-emit observability hook fired with the emit→ack latency in seconds.
 * Wired to `kernel_audit_lag_seconds` in apps/api boot.
 */
export type AuditSinkLagHook = (sink: string, latencySeconds: number) => void

/**
 * Per-event observability hook fired on each buffer-overflow → spill event.
 * Apps/api wires this to `kernel_audit_sink_buffer_size`.
 */
export type AuditSinkBufferSizeHook = (count: number) => void

/**
 * Per-event observability hook fired on each spill-list growth event.
 * Apps/api wires this to `kernel_audit_sink_spill_size`.
 */
export type AuditSinkSpillSizeHook = (count: number) => void

/**
 * Pre-constructed adapters + observability hooks passed to the leaf at
 * boot. All fields are required except the observability hooks.
 *
 * The adapters MUST be already-wrapped over the underlying clients
 * (Redis, Prisma, NATS). The leaf does NOT know about node-redis,
 * PrismaClient, or `publishNatsEvent` — those are adopter concerns and
 * live in `@ibatexas/llm-provider` (adapters) + `apps/api` (boot wiring).
 */
export interface AuditSinkDependencies {
  readonly spillStorage: PersistentSpillStorage
  readonly postgresWriter: AuditSinkPostgresWriter
  readonly natsPublisher: AuditSinkNatsPublisher
  readonly redactor: AuditSinkRedactor
  readonly logger: AuditSinkLogger
  /** Buffer capacity before records spill to durable storage (default 1000). */
  readonly bufferCapacity?: number
  /** Per-failure observability hook (apps/api → Prometheus). */
  readonly onSinkFailure?: (event: AuditSinkFailureEvent) => void
  /** Per-no-op observability hook (apps/api → Prometheus). */
  readonly onConflictNoOp?: AuditSinkDedupHook
  /** Per-emit latency observability hook (apps/api → Prometheus). */
  readonly onLag?: AuditSinkLagHook
  /** Per-event buffer-size observability hook. */
  readonly onBufferSize?: AuditSinkBufferSizeHook
  /** Per-event spill-size observability hook. */
  readonly onSpillSize?: AuditSinkSpillSizeHook
}

// ── Module-level lazy state ──────────────────────────────────────────────

let _deps: AuditSinkDependencies | null = null
let _sink: AuditSink | null = null

// ── Errors ───────────────────────────────────────────────────────────────

export class AuditSinkNotInitializedError extends Error {
  constructor() {
    super(
      "[audit-sink] getAuditSink() called before __setAuditSinkDependencies(). " +
        "Wire dependencies at app boot via `apps/api/src/audit-sink-bootstrap.ts` " +
        "(or equivalent) BEFORE the first kernel/wrapper call. See " +
        "docs/adjudicate-migration/audit-2026-05-24/tasks/h2-wrapper-audit-sink-architecture.md " +
        "§A1 for the boot-order contract.",
    )
    this.name = "AuditSinkNotInitializedError"
  }
}

// ── Boot wiring API ──────────────────────────────────────────────────────

/**
 * Boot-time dependency registration. MUST be called at app startup
 * AFTER the Redis + Prisma + NATS clients are constructed and the
 * adapters wrapped, BEFORE the first wrapper-call site fires (any
 * `medusaAdjudicated` / `medusaStoreAdjudicated` / `stripeAdjudicated`
 * / `twilioAdjudicated` call now requires `auditSink` at the type level).
 *
 * Calling twice REPLACES the previously-registered dependencies and
 * resets the cached sink — useful for in-process test harnesses that
 * swap stubs between test cases. Production code should call this exactly
 * once at boot.
 *
 * The `__` prefix mirrors the existing convention in
 * `@ibatexas/llm-provider/intent-audit-wiring.ts:_setAuditSinkDependencies`
 * for cross-package symmetry on internal-but-cross-package APIs.
 */
export function __setAuditSinkDependencies(
  deps: AuditSinkDependencies,
): void {
  _deps = deps
  _sink = null
}

/**
 * @internal — for test isolation. Resets the leaf's cached singletons so
 * the next `getAuditSink()` rebuilds against fresh dependencies. Pairs
 * with `__setAuditSinkDependencies(null as never)` to fully unset state.
 */
export function __resetAuditSink(): void {
  _deps = null
  _sink = null
}

// ── Sink construction ────────────────────────────────────────────────────

function buildInnerSink(deps: AuditSinkDependencies): AuditSink {
  const reportSinkFailure = (event: AuditSinkFailureEvent): void => {
    if (!deps.onSinkFailure) return
    try {
      deps.onSinkFailure(event)
    } catch {
      // Telemetry MUST NEVER block audit emission. Swallow.
    }
  }
  const errorClassOf = (err: unknown): string => {
    if (err instanceof Error) {
      return err.constructor.name || "Error"
    }
    return "unknown"
  }

  const nats = createNatsSink({
    publisher: {
      async publish(subject, payload) {
        // The injected publisher already prepends "ibatexas." (per
        // @ibatexas/nats-client's `publishNatsEvent` contract). Subscribers
        // filter on the full subject "ibatexas.audit.intent.decision.v1".
        await deps.natsPublisher.publish(
          subject,
          payload as Record<string, unknown>,
        )
      },
    },
    onFailure: (event) => {
      reportSinkFailure({
        sink: "nats",
        subject: event.subject,
        errorClass: event.errorClass,
        consecutiveFailures: event.consecutiveFailures,
      })
    },
  })

  const console_ = createConsoleSink({ prefix: "[ibx-audit]" })

  // Audit-postgres is always-on. Boot preflight in kernel-bootstrap.ts
  // verifies the `intent_audit` table exists before serving any traffic.
  // The writer's onConflictNoOp hook bridges to apps/api's
  // `kernel_audit_dedup_total{path="in_process"}` counter once the upstream
  // UNIQUE constraint lands.
  let postgresConsecutiveFailures = 0
  const postgresSink = createPostgresSink({
    writer: deps.postgresWriter,
    onError: (err: Error, record) => {
      postgresConsecutiveFailures += 1
      deps.logger.warn(
        { err: err.message, intentKind: record.envelope.kind },
        "[audit-sink] postgres sink emit failed — falling back to spill storage",
      )
      reportSinkFailure({
        sink: "postgres",
        subject: "audit.intent.decision.v1",
        errorClass: errorClassOf(err),
        consecutiveFailures: postgresConsecutiveFailures,
      })
    },
  })
  // Wrap to reset the consecutive-failure counter on success. The NatsSink
  // tracks this internally; PostgresSink doesn't, so we model it here.
  const postgresSinkWithReset: AuditSink = {
    async emit(record) {
      await postgresSink.emit(record)
      postgresConsecutiveFailures = 0
    },
  }

  return multiSink(console_, nats, postgresSinkWithReset)
}

function buildSink(deps: AuditSinkDependencies): AuditSink {
  const innerSink = buildInnerSink(deps)
  const capacity = deps.bufferCapacity ?? 1_000

  let bufferDepth = 0
  let spillDepth = 0
  let bufferSpillConsecutiveFailures = 0

  const reportSinkFailure = (event: AuditSinkFailureEvent): void => {
    if (!deps.onSinkFailure) return
    try {
      deps.onSinkFailure(event)
    } catch {
      // Telemetry MUST NEVER block audit emission. Swallow.
    }
  }

  const buffered = persistentBufferedSink({
    inner: innerSink,
    storage: deps.spillStorage,
    capacity,
    onOverflow: (record) => {
      deps.logger.warn(
        { intentKind: record.envelope.kind, intentHash: record.intentHash },
        "[audit-sink] audit buffer overflow — record spilled to durable storage",
      )
      spillDepth += 1
      if (deps.onSpillSize) {
        try {
          deps.onSpillSize(spillDepth)
        } catch {
          /* fail-open */
        }
      }
    },
    onSpill: (record, reason) => {
      if (reason !== "capacity") {
        deps.logger.warn(
          {
            intentKind: record.envelope.kind,
            intentHash: record.intentHash,
            reason,
          },
          "[audit-sink] audit spill",
        )
        bufferSpillConsecutiveFailures += 1
        reportSinkFailure({
          sink: "postgres",
          subject: "audit.intent.decision.v1",
          errorClass: `spill_${reason}`,
          consecutiveFailures: bufferSpillConsecutiveFailures,
        })
      } else {
        // Capacity-only spills mean the queue is shedding into durable
        // storage but no sink errored — reset the streak.
        bufferSpillConsecutiveFailures = 0
      }
      bufferDepth = Math.max(bufferDepth, capacity)
      if (deps.onBufferSize) {
        try {
          deps.onBufferSize(bufferDepth)
        } catch {
          /* fail-open */
        }
      }
    },
  })

  return {
    async emit(record: AuditRecord): Promise<void> {
      const redacted = deps.redactor.redact(record)
      const emitStart = Date.now()
      const emittedAtIso = record.at
      try {
        await buffered.emit(redacted)
        recordLag(deps, emittedAtIso, emitStart, "postgres")
      } catch (err) {
        recordLag(deps, emittedAtIso, emitStart, "spill")
        // Fail-open at the IbateXas boundary: a broken inner sink MUST
        // NOT block an adjudicate() call. The buffered sink has already
        // spilled to durable storage; log and return.
        deps.logger.warn(
          { intentKind: record.envelope.kind, err: String(err) },
          "[audit-sink] audit emit failed — record buffered for retry",
        )
      }
    },
  }
}

function recordLag(
  deps: AuditSinkDependencies,
  emittedAtIso: string,
  emitStart: number,
  sink: "postgres" | "nats" | "console" | "spill",
): void {
  if (!deps.onLag) return
  const emittedAt = Date.parse(emittedAtIso)
  if (!Number.isFinite(emittedAt)) return
  const now = Date.now()
  const latencyMs = Math.max(now - emittedAt, now - emitStart, 0)
  try {
    deps.onLag(sink, latencyMs / 1000)
  } catch {
    /* fail-open */
  }
}

// ── Public consumption API ───────────────────────────────────────────────

/**
 * Return the constructed audit sink. Fail-closed: throws
 * `AuditSinkNotInitializedError` if called before
 * `__setAuditSinkDependencies(...)`.
 *
 * Wrapper-call sites (cart tools, whatsapp client, etc.) call this on
 * every meta construction. The result is cached after the first call —
 * subsequent calls re-use the singleton.
 *
 * @throws AuditSinkNotInitializedError when boot wiring is missing.
 */
export function getAuditSink(): AuditSink {
  if (!_deps) {
    throw new AuditSinkNotInitializedError()
  }
  if (!_sink) {
    _sink = buildSink(_deps)
  }
  return _sink
}

/** @internal — for tests. Returns true if dependencies are registered. */
export function __auditSinkInitialized(): boolean {
  return _deps !== null
}

// ── Relocated audit-infrastructure surface (claustrum-on-dev WS1) ──────────
//
// The following adapters + the central wiring composition point moved into
// this package from `@ibatexas/llm-provider` (which is being deleted) so the
// audit/observability infrastructure survives. They were already injected
// into this leaf via `__setAuditSinkDependencies`; co-locating them keeps
// the leaf self-contained while preserving its zero-`@ibatexas/*`-runtime-dep
// invariant (the adapters take injected client interfaces, the NATS default
// is a no-op, and `rk` is inlined in redis-spill-storage).
//
// `@ibatexas/llm-provider/index.ts` re-exports every symbol below so existing
// importers keep working mid-migration.

// Central wiring composition point — `buildAuditSinkDependencies` (the
// apps/api bootstrap entry), the W3/P1-4 observability hook injectors, and
// the legacy test-injection shim.
export {
  buildAuditSinkDependencies,
  setAuditLagHook,
  setAuditRedactorFailureHook,
  setAuditSinkBufferSizeHook,
  setAuditSinkSpillSizeHook,
  setAuditSinkFailureHook,
  setAuditDedupHook,
  // Internal-only — exported for cross-package integration tests that need
  // to inject failing Postgres writers / Redis stubs.
  _setAuditSinkDependencies,
  _resetAuditSink,
  _getAuditRedactor,
  type AuditSinkLiveDependencies,
  type AuditSinkFailureEventLike,
  type LegacyAuditSinkDependencyOverride,
  type WiringLogger,
} from "./intent-audit-wiring.js"

// Postgres audit writer adapter (task 19 / M4) — wraps
// `prisma.$executeRawUnsafe` into the `PostgresWriter` contract. Exposed so
// the NATS audit-consumer can build its own writer against the same SQL.
export {
  createPostgresAuditWriter,
  type PrismaRawExecutor,
  type CreatePostgresAuditWriterOptions,
} from "./postgres-audit-writer.js"

// Redis spill storage (task 19 / M4) — durable backing store for the
// persistent buffered sink. `getRedisSpillSize` is exposed for ops tooling.
export {
  createRedisSpillStorage,
  getRedisSpillSize,
  type RedisListClient,
  type RedisSpillStorageOptions,
} from "./redis-spill-storage.js"

// Audit redactor (task 18 / M4) — the PII gate that wraps the buffered sink.
// `INTENT_KIND_FIELD_RULES` + `PII_FREE_KIND_ALLOWLIST` are exposed for the
// per-intent-kind redactor conformance suite.
export {
  createAuditRedactor,
  INTENT_KIND_FIELD_RULES,
  PII_FREE_KIND_ALLOWLIST,
  type AuditRedactor,
  type AuditRedactorOptions,
} from "./audit-redactor.js"
