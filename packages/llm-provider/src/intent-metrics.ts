// IBX-IGE Phase P0-f — Observability primitives.
//
// Centralizes the four signals an operator needs to see for the kernel:
//   • ledger ops      — hit/miss/latency
//   • decisions       — kind distribution per intent class
//   • refusals        — kind/code distribution
//   • sink failures   — NATS audit emit failures (counts toward circuit-breaker)
//
// Exposes record* functions that:
//   1. emit a structured console.warn line (operator triage during incidents)
//   2. invoke a pluggable MetricsSink for analytics (PostHog) + Sentry
//
// IbateXas wiring (in `apps/api/src/plugins/sentry.ts` extension or similar)
// installs a real sink at boot. Tests can install a mock sink for assertions.

import type { Decision, Refusal } from "@adjudicate/intent-core"
import type {
  DivergenceClass,
  LegacyDecisionResult,
  ShadowTelemetrySink,
} from "./intent-shadow.js"
import { setShadowTelemetrySink } from "./intent-shadow.js"

// ── Sink contract ────────────────────────────────────────────────────────────

export interface MetricsSink {
  /** Ledger hit / miss / record / latency. */
  recordLedgerOp(op: LedgerOpEvent): void
  /** Final Decision per intent kind. */
  recordDecision(event: DecisionEvent): void
  /** REFUSE Decisions, broken out by refusal.kind/code. */
  recordRefusal(event: RefusalEvent): void
  /** Audit sink failures (NATS, console, Postgres). */
  recordSinkFailure(event: SinkFailureEvent): void
  /** Shadow-mode divergence (one of the four DivergenceClass values). */
  recordShadowDivergence(event: ShadowDivergenceEvent): void
}

export interface LedgerOpEvent {
  readonly op: "check" | "record"
  readonly outcome: "hit" | "miss" | "ok" | "duplicate" | "error"
  readonly intentKind: string
  readonly latencyMs: number
}

export interface DecisionEvent {
  readonly intentKind: string
  readonly decision: Decision["kind"]
  readonly latencyMs: number
  readonly basisCount: number
  /** Audit subject for cross-referencing the durable trail. */
  readonly intentHash: string
}

export interface RefusalEvent {
  readonly intentKind: string
  readonly refusal: Refusal
  readonly intentHash: string
}

export interface SinkFailureEvent {
  readonly sink: "console" | "nats" | "postgres"
  readonly subject: string
  readonly errorClass: string
  readonly consecutiveFailures: number
}

export interface ShadowDivergenceEvent {
  readonly intentKind: string
  readonly divergence: DivergenceClass
  readonly legacy: LegacyDecisionResult
  readonly adjudicate: Decision
}

// ── Default no-op sink ───────────────────────────────────────────────────────

let _sink: MetricsSink = noopSink()

export function setMetricsSink(sink: MetricsSink): void {
  _sink = sink
  // Also wire the shadow telemetry sink so all four divergence classes are
  // routed through the same pipeline as the rest of the metrics.
  setShadowTelemetrySink({
    recordBasisOnly(intentKind, decision) {
      _sink.recordShadowDivergence({
        intentKind,
        divergence: "BASIS_ONLY",
        legacy: { kind: "EXECUTE" },
        adjudicate: decision,
      })
    },
    alertDecisionKind(intentKind, legacy, decision) {
      _sink.recordShadowDivergence({
        intentKind,
        divergence: "DECISION_KIND",
        legacy,
        adjudicate: decision,
      })
    },
    alertPayloadRewrite(intentKind, decision) {
      _sink.recordShadowDivergence({
        intentKind,
        divergence: "PAYLOAD_REWRITE",
        legacy: { kind: "EXECUTE" },
        adjudicate: decision,
      })
    },
  } satisfies ShadowTelemetrySink)
}

/** @internal — for tests. */
export function _resetMetricsSink(): void {
  _sink = noopSink()
}

function noopSink(): MetricsSink {
  return {
    recordLedgerOp() {},
    recordDecision() {},
    recordRefusal() {},
    recordSinkFailure() {},
    recordShadowDivergence() {},
  }
}

// ── Helper functions used by call sites ─────────────────────────────────────

export function recordLedgerOp(event: LedgerOpEvent): void {
  _sink.recordLedgerOp(event)
}

export function recordDecision(event: DecisionEvent): void {
  _sink.recordDecision(event)
}

export function recordRefusal(event: RefusalEvent): void {
  _sink.recordRefusal(event)
}

export function recordSinkFailure(event: SinkFailureEvent): void {
  _sink.recordSinkFailure(event)
}

// ── Ready-made console+log sink for development ────────────────────────────

/**
 * Reference sink that logs to console. Production replaces this with a sink
 * that emits Sentry breadcrumbs and posts to the analytics pipeline. Useful
 * out-of-the-box: `setMetricsSink(createConsoleMetricsSink())` at boot gives
 * full operator visibility with no extra dependencies.
 */
export function createConsoleMetricsSink(): MetricsSink {
  return {
    recordLedgerOp(event) {
      console.log("[ibx-metrics] ledger", JSON.stringify(event))
    },
    recordDecision(event) {
      console.log(
        "[ibx-metrics] decision",
        JSON.stringify({ ...event, intentHash: event.intentHash.slice(0, 8) }),
      )
    },
    recordRefusal(event) {
      console.warn(
        "[ibx-metrics] refusal",
        JSON.stringify({
          intentKind: event.intentKind,
          kind: event.refusal.kind,
          code: event.refusal.code,
          intentHash: event.intentHash.slice(0, 8),
        }),
      )
    },
    recordSinkFailure(event) {
      console.error("[ibx-metrics] sink_failure", JSON.stringify(event))
    },
    recordShadowDivergence(event) {
      const fn =
        event.divergence === "BASIS_ONLY"
          ? console.log
          : console.warn
      fn(
        "[ibx-metrics] shadow_divergence",
        JSON.stringify({
          intentKind: event.intentKind,
          divergence: event.divergence,
          legacy: event.legacy.kind,
          adjudicate: event.adjudicate.kind,
        }),
      )
    },
  }
}
