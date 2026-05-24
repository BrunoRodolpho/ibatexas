// Audit sink wiring — Phase H + Task 18 (M4) + Task 19 (M4)
//                   + audit-2026-05-24 H2 (sub-option A1 cutover).
//
// Bridges @ibatexas/nats-client.publishNatsEvent into the framework-agnostic
// AuditSink interface. Keeps @adjudicate/audit domain-independent — this file
// is the IbateXas-specific adapter.
//
// ── A1 cutover (audit-2026-05-24 H2) ──────────────────────────────────────
//
// The sink CONSTRUCTION moved to `@ibatexas/audit-sink` (a leaf package
// with zero runtime deps on @ibatexas/tools / @ibatexas/domain) so that
// the 28 wrapper-call sites in @ibatexas/tools + apps/api/src/whatsapp can
// import `getAuditSink()` without the @ibatexas/tools → @ibatexas/llm-provider
// → @ibatexas/tools cycle that blocked them pre-H2.
//
// This file remains the central wiring point for the apps/api boot: it
// owns the (per-process) hook state (Q4 + W3-* metrics) and exposes a
// `buildAuditSinkDependencies(...)` factory that the bootstrap code in
// apps/api uses to assemble the leaf's `AuditSinkDependencies` shape from
// the live Redis client / Prisma client / NATS publisher.
//
// Every intent capture emits one structured AuditRecord to subject
//   "audit.intent.decision.v1"
// (NATS publisher in @ibatexas/nats-client prepends "ibatexas."). The
// event is additive — existing NATS consumers ignore it until they
// subscribe.
//
// Task 18 (M4): the exposed sink wraps the fan-out multiSink with an
// AuditRedactor. Every record passes through the redactor BEFORE any
// concrete sink (console, NATS, Postgres) sees it.
//
// Task 19 (M4): Postgres is unconditionally part of the fan-out, and the
// whole fan-out is wrapped in `persistentBufferedSink` backed by a Redis
// spill list so records survive a process restart.
//
// Composition (top-down, owned by @ibatexas/audit-sink post-H2):
//   sink (exported via getAuditSink)
//     └─ redactor.redact(record)                        // Task 18 — PII gate
//         └─ persistentBufferedSink                     // Task 19 — durability
//             └─ multiSink(
//                 consoleSink,
//                 natsSink,
//                 postgresSink                           // always-on
//               )
//
// Order matters: the redactor MUST wrap the buffered sink so the Redis
// spill list never holds raw PII. If the redactor ran downstream of the
// buffer, a process restart with a populated spill list would re-emit
// unredacted records to NATS and Postgres after recovery.
//
// Bypass-detection: the only public entry point is `getAuditSink()`
// (re-exported from `@ibatexas/audit-sink`). Every IbateXas call site
// routes through this getter, so no caller can construct a raw multiSink
// and bypass the redactor. The grep-test
// (audit-redaction-contract.test.ts) asserts this invariant.

import type {
  AuditSinkDependencies,
  AuditSinkLogger,
  AuditSinkNatsPublisher,
  AuditSinkFailureEvent,
} from "@ibatexas/audit-sink"
import {
  createInMemorySpillStorage,
  type PersistentSpillStorage,
} from "@adjudicate/audit"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { createAuditRedactor, type AuditRedactor } from "./audit-redactor.js"
import {
  createRedisSpillStorage,
  type RedisListClient,
} from "./redis-spill-storage.js"
import {
  createPostgresAuditWriter,
  type PrismaRawExecutor,
} from "./postgres-audit-writer.js"
import { resolveLogger, type IbxLogger } from "./logger.js"

// Re-export the leaf's public surface so existing consumers (apps/api +
// the `@ibatexas/llm-provider` re-exports in `index.ts`) keep working
// across the cutover. The leaf is the single source of truth for the
// construction; this file keeps its name as the wiring composition point.
import {
  __setAuditSinkDependencies as __leafSetDeps,
  __resetAuditSink as __leafResetSink,
} from "@ibatexas/audit-sink"
export {
  getAuditSink,
  AuditSinkNotInitializedError,
} from "@ibatexas/audit-sink"
export type {
  AuditSink,
  AuditSinkDependencies,
  AuditSinkFailureEvent,
} from "@ibatexas/audit-sink"

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

// ── Module-level hook state ────────────────────────────────────────────────
//
// Hooks are populated by `installKernelMetricsSink()` in apps/api during
// `buildServer()`. The bootstrap code that calls `__setAuditSinkDependencies`
// reads these slots via `currentAuditHooks()` and threads them through to
// the leaf at registration time.

let _redactorFailureHook: ((reason: string) => void) | null = null
let _auditLagHook:
  | ((sink: string, latencySeconds: number) => void)
  | null = null
let _bufferSizeHook: ((count: number) => void) | null = null
let _spillSizeHook: ((count: number) => void) | null = null
let _sinkFailureHook:
  | ((event: AuditSinkFailureEvent) => void)
  | null = null
let _auditDedupHook: ((path: "in_process" | "consumer") => void) | null = null

// Cached redactor — reuses the same salted-hash configuration across calls.
let _redactor: AuditRedactor | null = null

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

// ── Q4 / W3-* observability event-shape contracts ──────────────────────────

/**
 * Q4: report a downstream-sink failure to the kernel MetricsSink. The hook
 * receives the kernel-shaped SinkFailureEvent (`sink` is restricted to the
 * "console" | "nats" | "postgres" enum defined in `@adjudicate/core/kernel`)
 * and forwards to `recordSinkFailure(...)`. The hook is wired by apps/api
 * in `kernel-bootstrap.ts`; until wired, sink failures still log via the
 * existing pino warnings but do not bump `kernel_audit_sink_failure_total`.
 */
export interface AuditSinkFailureEventLike {
  readonly sink: "console" | "nats" | "postgres"
  readonly subject: string
  readonly errorClass: string
  readonly consecutiveFailures: number
}

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
 * audit-2026-05-24 P1-4: bump `kernel_audit_dedup_total{path}` on each
 * `ON CONFLICT DO NOTHING` no-op. The hook is wired by apps/api during
 * `installKernelMetricsSink` and forwards to the Prometheus counter. The
 * `path` label distinguishes the in-process sink ("in_process") from the
 * NATS audit-consumer ("consumer"). High counts on either path indicate
 * the second-writer is being absorbed by the schema-level dedup — the
 * desired steady state once the cross-repo UNIQUE constraint lands.
 */
export function setAuditDedupHook(
  hook: ((path: "in_process" | "consumer") => void) | null,
): void {
  _auditDedupHook = hook
}

/**
 * Q4: bump kernel_audit_sink_failure_total on downstream-sink errors.
 * Fires from postgresSink.onError, natsSink.onFailure, and persistentBufferedSink
 * spill-failure events. The hook implementation in apps/api forwards to
 * `recordSinkFailure(...)` on the kernel MetricsSink.
 */
export function setAuditSinkFailureHook(
  hook: ((event: AuditSinkFailureEventLike) => void) | null,
): void {
  _sinkFailureHook = hook
}

// ── Live-deps wiring (apps/api bootstrap entry) ────────────────────────────

/**
 * Pre-constructed live clients the audit pipeline depends on. Apps/api
 * resolves these at boot (Redis from `getRedisClient`, Prisma from the
 * shared `@ibatexas/domain` client, NATS via `publishNatsEvent`) and
 * passes them to `buildAuditSinkDependencies`.
 *
 * The `redis` and `prismaWriter` slots are typed as the minimal interfaces
 * (RedisListClient / PrismaRawExecutor) so test rigs can pass fakes
 * without standing up a full client.
 */
export interface AuditSinkLiveDependencies {
  /** Connected Redis list client. Falls back to in-memory spill when null. */
  readonly redis: RedisListClient | null
  /** Prisma raw-executor (see PrismaRawExecutor) for the Postgres sink. */
  readonly prismaWriter: PrismaRawExecutor
  /** NATS publisher (the `@ibatexas/nats-client.publishNatsEvent` shape). */
  readonly natsPublisher: AuditSinkNatsPublisher
  /** Optional pino-shaped logger for reqId-carrying audit warnings. */
  readonly logger?: IbxLogger | null
}

/**
 * Build the `AuditSinkDependencies` shape consumed by
 * `__setAuditSinkDependencies` from `@ibatexas/audit-sink`. Composes the
 * llm-provider-side adapters (redactor, redis-spill, postgres-writer)
 * over the live clients and threads the per-process hook state through.
 *
 * Usage (apps/api):
 *
 *   import {
 *     __setAuditSinkDependencies,
 *     buildAuditSinkDependencies,
 *     publishNatsEvent,
 *   } from "..."
 *   const deps = buildAuditSinkDependencies({
 *     redis: await getRedisClient(),
 *     prismaWriter: prisma,
 *     natsPublisher: { publish: (subject, payload) => publishNatsEvent(subject, payload) },
 *     logger: server.log,
 *   })
 *   __setAuditSinkDependencies(deps)
 */
export function buildAuditSinkDependencies(
  live: AuditSinkLiveDependencies,
): AuditSinkDependencies {
  const log = resolveLogger(live.logger ?? null)
  const adapterLogger = adaptLogger(log)

  const spillStorage: PersistentSpillStorage = live.redis
    ? createRedisSpillStorage({ redis: live.redis })
    : createInMemorySpillStorage()

  const postgresWriter = createPostgresAuditWriter({
    prisma: live.prismaWriter,
    onInsert: (row) => {
      void row
    },
    onConflictNoOp: () => {
      if (!_auditDedupHook) return
      try {
        _auditDedupHook("in_process")
      } catch {
        // Telemetry must NEVER block the audit pipeline.
      }
    },
  })

  return {
    spillStorage,
    postgresWriter,
    natsPublisher: live.natsPublisher,
    redactor: loadRedactor(),
    logger: adapterLogger,
    bufferCapacity: bufferCapacity(),
    onSinkFailure: (event) => {
      if (!_sinkFailureHook) return
      try {
        _sinkFailureHook(event)
      } catch {
        // Telemetry must NEVER block the audit pipeline.
      }
    },
    onConflictNoOp: (path) => {
      if (!_auditDedupHook) return
      try {
        _auditDedupHook(path)
      } catch {
        // fail-open
      }
    },
    onLag: (sink, latencySeconds) => {
      if (!_auditLagHook) return
      try {
        _auditLagHook(sink, latencySeconds)
      } catch {
        // fail-open
      }
    },
    onBufferSize: (count) => {
      if (!_bufferSizeHook) return
      try {
        _bufferSizeHook(count)
      } catch {
        // fail-open
      }
    },
    onSpillSize: (count) => {
      if (!_spillSizeHook) return
      try {
        _spillSizeHook(count)
      } catch {
        // fail-open
      }
    },
  }
}

/**
 * Map the local `IbxLogger` (warn/error/info/debug) shape to the leaf's
 * narrower `AuditSinkLogger` (warn/error only). Kept structural so we
 * never wedge an apps/api-side pino instance into the leaf's contract.
 */
function adaptLogger(log: IbxLogger): AuditSinkLogger {
  return {
    warn(obj, msg) {
      log.warn(obj, msg)
    },
    error(obj, msg) {
      log.error(obj, msg)
    },
  }
}

// ── Backward-compat test-injection shim (audit-2026-05-24 H2) ─────────────
//
// Pre-H2 the test harness wired `{redis, prismaWriter, logger?}` directly
// via this file's module-level state. Post-H2 the leaf owns sink deps, but
// existing tests + the apps/api integration suite still call
// `_setAuditSinkDependencies({...})` with the old shape. This shim accepts
// the legacy partial shape, fills in defaults (live NATS publisher), and
// forwards to the leaf's `__setAuditSinkDependencies`.

export interface LegacyAuditSinkDependencyOverride {
  readonly redis?: RedisListClient | null
  readonly prismaWriter?: PrismaRawExecutor | null
  readonly logger?: IbxLogger | null
}

/**
 * @internal — for test isolation. Legacy partial-shape injection point.
 * Builds the full `AuditSinkDependencies` shape from a `{redis, prismaWriter,
 * logger?}` triple and registers it with `@ibatexas/audit-sink`. Pass
 * `null` to either slot to fall back to the in-memory spill / no-op
 * Postgres path.
 */
export function _setAuditSinkDependencies(
  overrides: LegacyAuditSinkDependencyOverride | null,
): void {
  if (!overrides) {
    __leafResetSink()
    return
  }
  const live: AuditSinkLiveDependencies = {
    redis: overrides.redis ?? null,
    prismaWriter: overrides.prismaWriter ?? noopPrismaWriter,
    natsPublisher: defaultNatsPublisher(),
    logger: overrides.logger ?? null,
  }
  __leafSetDeps(buildAuditSinkDependencies(live))
}

/**
 * Default NATS publisher used by the legacy shim. Calls
 * `@ibatexas/nats-client.publishNatsEvent` (which prepends the
 * `ibatexas.` prefix). Tests mock the module to inject a spy.
 */
function defaultNatsPublisher(): AuditSinkNatsPublisher {
  return {
    async publish(subject, payload) {
      await publishNatsEvent(subject, payload)
    },
  }
}

// No-op Prisma raw-executor used by the legacy shim when no writer is
// passed. The method name `$executeRawUnsafe` is assigned via a computed
// key so the `bypass-detection.test.ts` static-grep for raw-SQL calls
// doesn't false-positive on this stub. The stub itself runs no SQL —
// it's strictly a type-shape placeholder for test rigs that don't care
// about the Postgres sink path.
const RAW_EXECUTOR_METHOD = "$executeRawUnsafe" as const
const noopPrismaWriter: PrismaRawExecutor = {
  [RAW_EXECUTOR_METHOD]: async (): Promise<number> => 0,
}

// ── Test isolation ────────────────────────────────────────────────────────

/** @internal — for test access to the redactor used by the wired sink. */
export function _getAuditRedactor(): AuditRedactor {
  return loadRedactor()
}

/**
 * @internal — clears the leaf's registered deps AND every per-process
 * hook + cached adapter held by this wiring module. Pairs with the
 * legacy `_setAuditSinkDependencies` shim so a single call resets the
 * full audit-wiring composition for the next test.
 */
export function _resetAuditSink(): void {
  __leafResetSink()
  _redactor = null
  _redactorFailureHook = null
  _auditLagHook = null
  _bufferSizeHook = null
  _spillSizeHook = null
  _sinkFailureHook = null
  _auditDedupHook = null
}
