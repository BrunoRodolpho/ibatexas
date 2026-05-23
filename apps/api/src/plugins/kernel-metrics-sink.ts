// Real MetricsSink adapter for the IBX-IGE kernel.
//
// Fans-out kernel observability events to three backends:
//   • PostHog   — via NATS (analytics.event) — for product-side dashboards and
//                 the 8 `audit_*` events declared in
//                 `apps/web/src/domains/analytics/events.ts:107-114`.
//   • Sentry    — `addBreadcrumb` on refusals + sink failures only (volume
//                 control; recordDecision is suppressed to avoid noise).
//   • Prometheus — counters / histograms registered on a `prom-client` Registry
//                 scraped by `GET /metrics` (auth-gated by `PROMETHEUS_TOKEN`).
//
// Failure mode: every backend call is wrapped — a metric publish error MUST
// NEVER block a kernel decision. We catch, log via the bound pino logger if
// available, and swallow.
//
// Wiring: composed in `kernel-bootstrap.ts` (Task 01) and passed to
// `setMetricsSink(...)` from `@adjudicate/core/kernel`. The same `Registry`
// instance is shared with `routes/metrics.ts` so the scrape endpoint exposes
// the counters this sink populates.

import type {
  DecisionEvent,
  LedgerOpEvent,
  MetricsSink,
  RefusalEvent,
  ResourceLimitEvent,
  ShadowDivergenceEvent,
  SinkFailureEvent,
} from "@adjudicate/core/kernel"
import * as Sentry from "@sentry/node"
import {
  Counter,
  Histogram,
  Registry,
  type CounterConfiguration,
  type HistogramConfiguration,
} from "prom-client"

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Server-side analytics publish function. Mirrors the in-process shape of
 * `publishNatsEvent("analytics.event", { eventType, properties, ... })`. Kept
 * narrow so tests can inject a mock without pulling in the NATS client.
 */
export type TrackAnalytics = (
  eventType: string,
  properties: Record<string, unknown>,
) => void | Promise<void>

/** Minimum logger shape we use — compatible with pino & FastifyBaseLogger. */
export interface MetricsSinkLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
  debug?(obj: Record<string, unknown>, msg?: string): void
}

export interface KernelMetricsSinkDeps {
  /** Server-side analytics publisher (NATS-backed PostHog wire). */
  readonly trackAnalytics: TrackAnalytics
  /** Sentry SDK instance (pass `@sentry/node` namespace). */
  readonly sentry: Pick<typeof Sentry, "addBreadcrumb">
  /** pino-compatible logger for fail-open error reporting. */
  readonly log: MetricsSinkLogger
  /** prom-client Registry — shared with the `/metrics` route. */
  readonly register: Registry
}

// ── PostHog event name constants ────────────────────────────────────────────
//
// These MUST match the `AnalyticsEvent` union entries in
// `apps/web/src/domains/analytics/events.ts:107-114` (CLAUDE.md rule #8).

const PH_EVENT_DECISION_EXECUTED = "audit_decision_executed"
const PH_EVENT_DECISION_REFUSED = "audit_decision_refused"
const PH_EVENT_LEDGER_HIT = "audit_ledger_hit"
const PH_EVENT_NATS_SINK_FAILED = "audit_nats_sink_failed"
const PH_EVENT_SHADOW_DIVERGED_BASIS = "audit_kernel_shadow_diverged_basis"
const PH_EVENT_SHADOW_DIVERGED_KIND = "audit_kernel_shadow_diverged_kind"
const PH_EVENT_SHADOW_DIVERGED_REWRITE = "audit_kernel_shadow_diverged_rewrite"

// ── Prometheus metric definitions ────────────────────────────────────────────
//
// Names match `docs/adjudicate-migration/migration/06-observability-requirements.md`.
// Adding a new metric? Update that doc + `docs/ops/analytics-dashboards.md`.

interface RegisteredMetrics {
  readonly decisionTotal: Counter<"kind" | "intent_kind">
  readonly refusalTotal: Counter<
    "kind" | "intent_kind" | "basis_category" | "basis_code"
  >
  readonly decisionDuration: Histogram<"intent_kind">
  readonly shadowDivergenceTotal: Counter<"class" | "intent_kind">
  readonly ledgerOpTotal: Counter<"outcome" | "op">
  readonly auditSinkFailureTotal: Counter<"sink" | "reason">
  readonly deferResumeDuration: Histogram<"kind">
}

function counter<L extends string>(
  config: CounterConfiguration<L>,
  registers: Registry[],
): Counter<L> {
  return new Counter<L>({ ...config, registers })
}

function histogram<L extends string>(
  config: HistogramConfiguration<L>,
  registers: Registry[],
): Histogram<L> {
  return new Histogram<L>({ ...config, registers })
}

function registerMetrics(register: Registry): RegisteredMetrics {
  return {
    decisionTotal: counter(
      {
        name: "kernel_decision_total",
        help: "Total adjudicate() Decisions by kind + intent class.",
        labelNames: ["kind", "intent_kind"] as const,
      },
      [register],
    ),
    refusalTotal: counter(
      {
        name: "kernel_refusal_total",
        help: "REFUSE decisions broken out by refusal category + code.",
        labelNames: [
          "kind",
          "intent_kind",
          "basis_category",
          "basis_code",
        ] as const,
      },
      [register],
    ),
    decisionDuration: histogram(
      {
        name: "kernel_decision_duration_seconds",
        help: "adjudicate() latency in seconds, by intent class.",
        labelNames: ["intent_kind"] as const,
        // Standard Prometheus latency buckets, per migration doc §metric 2.
        buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      },
      [register],
    ),
    shadowDivergenceTotal: counter(
      {
        name: "kernel_shadow_divergence_total",
        help: "Shadow-mode divergences between legacy and adjudicate decisions.",
        labelNames: ["class", "intent_kind"] as const,
      },
      [register],
    ),
    ledgerOpTotal: counter(
      {
        name: "kernel_ledger_op_total",
        help: "Execution Ledger check/record ops by outcome.",
        labelNames: ["outcome", "op"] as const,
      },
      [register],
    ),
    auditSinkFailureTotal: counter(
      {
        name: "kernel_audit_sink_failure_total",
        help: "Audit sink emit failures by sink + reason.",
        labelNames: ["sink", "reason"] as const,
      },
      [register],
    ),
    deferResumeDuration: histogram(
      {
        name: "kernel_defer_resume_duration_seconds",
        help: "DEFER park → resume latency in seconds (populated by resolver).",
        labelNames: ["kind"] as const,
        // Wider buckets — DEFER resumes wait on external signals (webhooks, PSP).
        buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 3600, 14400],
      },
      [register],
    ),
  }
}

// ── Sink factory ─────────────────────────────────────────────────────────────

/**
 * Build a fail-open `MetricsSink` that fans out to PostHog (via NATS),
 * Sentry breadcrumbs, and Prometheus counters/histograms.
 *
 * Each method swallows downstream errors — kernel adjudication MUST NOT
 * be blocked by a metric publish failure.
 */
export function createKernelMetricsSink(
  deps: KernelMetricsSinkDeps,
): MetricsSink {
  const { trackAnalytics, sentry, log, register } = deps
  const metrics = registerMetrics(register)

  const safeTrack = (event: string, properties: Record<string, unknown>): void => {
    try {
      const r = trackAnalytics(event, properties)
      if (r && typeof (r as Promise<void>).then === "function") {
        ;(r as Promise<void>).catch((err: unknown) => {
          log.warn(
            { err: serializeError(err), event },
            "kernel-metrics: analytics publish rejected",
          )
        })
      }
    } catch (err) {
      log.warn(
        { err: serializeError(err), event },
        "kernel-metrics: analytics publish threw",
      )
    }
  }

  const safeBreadcrumb = (
    category: string,
    message: string,
    data: Record<string, unknown>,
    level: "info" | "warning" | "error" = "warning",
  ): void => {
    try {
      sentry.addBreadcrumb({ category, message, data, level })
    } catch (err) {
      log.warn(
        { err: serializeError(err), category },
        "kernel-metrics: sentry breadcrumb threw",
      )
    }
  }

  const safeIncr = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      log.warn(
        { err: serializeError(err), metric: label },
        "kernel-metrics: prom-client mutation threw",
      )
    }
  }

  return {
    // ── recordLedgerOp ───────────────────────────────────────────────────────
    recordLedgerOp(event: LedgerOpEvent) {
      safeIncr("kernel_ledger_op_total", () => {
        metrics.ledgerOpTotal.inc({ outcome: event.outcome, op: event.op })
      })
      // PostHog: only emit on hit (per task table — suppress miss noise).
      if (event.outcome === "hit") {
        safeTrack(PH_EVENT_LEDGER_HIT, {
          intent_kind: event.intentKind,
          op: event.op,
          outcome: event.outcome,
          latency_ms: event.latencyMs,
        })
      }
    },

    // ── recordDecision ───────────────────────────────────────────────────────
    recordDecision(event: DecisionEvent) {
      safeIncr("kernel_decision_total", () => {
        metrics.decisionTotal.inc({
          kind: event.decision,
          intent_kind: event.intentKind,
        })
      })
      safeIncr("kernel_decision_duration_seconds", () => {
        metrics.decisionDuration.observe(
          { intent_kind: event.intentKind },
          event.latencyMs / 1000,
        )
      })
      // PostHog: split on decision kind per task table.
      const phEvent =
        event.decision === "EXECUTE"
          ? PH_EVENT_DECISION_EXECUTED
          : PH_EVENT_DECISION_REFUSED
      safeTrack(phEvent, {
        intent_kind: event.intentKind,
        decision_kind: event.decision,
        latency_ms: event.latencyMs,
        basis_count: event.basisCount,
        intent_hash_prefix: event.intentHash.slice(0, 8),
      })
      // No Sentry breadcrumb for decisions — volume too high.
    },

    // ── recordRefusal ────────────────────────────────────────────────────────
    recordRefusal(event: RefusalEvent) {
      safeIncr("kernel_refusal_total", () => {
        metrics.refusalTotal.inc({
          kind: event.refusal.kind,
          intent_kind: event.intentKind,
          basis_category: event.refusal.kind,
          basis_code: event.refusal.code,
        })
      })
      // No PostHog event here — recordDecision already emitted
      // `audit_decision_refused` for the REFUSE Decision; this hook adds the
      // refusal-specific dimensions to Sentry.
      safeBreadcrumb(
        "audit_refused",
        `kernel REFUSE on ${event.intentKind}`,
        {
          intent_kind: event.intentKind,
          refusal_kind: event.refusal.kind,
          refusal_code: event.refusal.code,
          intent_hash_prefix: event.intentHash.slice(0, 8),
        },
        "warning",
      )
    },

    // ── recordSinkFailure ────────────────────────────────────────────────────
    recordSinkFailure(event: SinkFailureEvent) {
      safeIncr("kernel_audit_sink_failure_total", () => {
        metrics.auditSinkFailureTotal.inc({
          sink: event.sink,
          reason: event.errorClass,
        })
      })
      safeTrack(PH_EVENT_NATS_SINK_FAILED, {
        sink: event.sink,
        subject: event.subject,
        error_class: event.errorClass,
        consecutive_failures: event.consecutiveFailures,
      })
      safeBreadcrumb(
        "sink_failure",
        `audit sink ${event.sink} failed`,
        {
          sink: event.sink,
          subject: event.subject,
          error_class: event.errorClass,
          consecutive_failures: event.consecutiveFailures,
        },
        // Escalate to error once we cross the circuit-breaker threshold.
        event.consecutiveFailures >= 10 ? "error" : "warning",
      )
    },

    // ── recordShadowDivergence ───────────────────────────────────────────────
    recordShadowDivergence(event: ShadowDivergenceEvent) {
      safeIncr("kernel_shadow_divergence_total", () => {
        metrics.shadowDivergenceTotal.inc({
          class: event.divergence,
          intent_kind: event.intentKind,
        })
      })
      const phEvent = shadowDivergenceToPostHogEvent(event.divergence)
      if (phEvent) {
        safeTrack(phEvent, {
          intent_kind: event.intentKind,
          divergence_class: event.divergence,
          legacy_kind: event.legacy.kind,
          adjudicate_kind: event.adjudicate.kind,
          basis_count: event.adjudicate.basis.length,
        })
      }
      // No Sentry breadcrumb — divergence is metrics-only per task table.
    },

    // ── recordResourceLimit ──────────────────────────────────────────────────
    // Prometheus only — no PostHog event allocated. Reserves a slot for a
    // future `kernel_defer_quota_exceeded_total` counter; today the historgram
    // bucket is sufficient for alerting.
    recordResourceLimit(event: ResourceLimitEvent) {
      log.debug?.(
        {
          resource: event.resource,
          subject: event.subject,
          limit: event.limit,
          observed: event.observed,
        },
        "kernel-metrics: resource limit",
      )
    },
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function shadowDivergenceToPostHogEvent(
  cls: ShadowDivergenceEvent["divergence"],
): string | null {
  switch (cls) {
    case "BASIS_ONLY":
      return PH_EVENT_SHADOW_DIVERGED_BASIS
    case "DECISION_KIND":
      return PH_EVENT_SHADOW_DIVERGED_KIND
    case "PAYLOAD_REWRITE":
      return PH_EVENT_SHADOW_DIVERGED_REWRITE
    // NONE never reaches the sink (shadow.ts only invokes telemetry on
    // non-NONE divergence) — return null defensively.
    case "NONE":
    default:
      return null
  }
}

function serializeError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name }
  }
  return { message: String(err) }
}
