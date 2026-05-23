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
  Gauge,
  Histogram,
  Registry,
  type CounterConfiguration,
  type GaugeConfiguration,
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
  /**
   * W5-9 — KNOWN_INTENT_KINDS for the coverage gauge. Optional: when
   * omitted, the coverage gauge stays at 0 and the
   * `kernel_distinct_intent_kinds_observed` gauge still publishes —
   * the operator can compute coverage manually from the absolute count.
   *
   * The expected wiring is `kernel-bootstrap.ts` passes
   * `KNOWN_INTENT_KINDS` from `@ibatexas/llm-provider` so the sink can
   * publish `count / KNOWN_INTENT_KINDS.size` as a ratio.
   */
  readonly knownIntentKinds?: ReadonlySet<string>
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
  /**
   * W5-9 — governance coverage gauge.
   *
   * Tracks `KNOWN_INTENT_KINDS.size` / count_distinct(intent_kind in
   * last 24h). Value < 100% means the system emitted an intent kind
   * that is NOT in the typo gate — i.e., either an undocumented kind
   * leaked through (potential bug) OR a new caller appeared with a
   * kind the Pack surface doesn't recognize (silent default-REFUSE
   * under enforce).
   *
   * Published as a single-sample gauge; the apps/api ops dashboard
   * subscribes via Prometheus scrape and alerts when the value drops
   * below 1.0.
   */
  readonly intentKindCoverage: Gauge<never>
  /** Companion: how many distinct intent kinds we've observed in the window. */
  readonly distinctIntentKindsObserved: Gauge<never>
  /** Companion: the total known intent kinds count (KNOWN_INTENT_KINDS.size). */
  readonly knownIntentKindsTotal: Gauge<never>

  // ── W3 (correctness wave) — the 11 previously-GHOST metrics ──────────
  //
  // Declared in `migration/06-observability-requirements.md` as "the
  // contract" but had no producer in code. Closing the gap surfaces them
  // on /metrics so the alert rules in the doc become testable.
  // Source: docs/adjudicate-migration/deep-audit/06-docs-vs-reality.md
  // §"Ghost metrics".

  readonly auditLagSeconds: Histogram<"sink">
  readonly replayDriftTotal: Counter<"class">
  readonly killSwitchState: Gauge<"scope">
  readonly packInstallTotal: Counter<"pack">
  readonly deferPendingGauge: Gauge<never>
  readonly deferQuotaExceededTotal: Counter<"kind">
  readonly deferTimeoutTotal: Counter<"kind">
  readonly auditRedactorFailuresTotal: Counter<"reason">
  readonly auditSinkBufferSize: Gauge<never>
  readonly auditSinkSpillSize: Gauge<never>
  readonly intentKindUnknownTotal: Counter<"kind">
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

function gauge<L extends string>(
  config: GaugeConfiguration<L>,
  registers: Registry[],
): Gauge<L> {
  return new Gauge<L>({ ...config, registers })
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
    intentKindCoverage: gauge(
      {
        name: "kernel_intent_kind_coverage",
        help: "Ratio of KNOWN_INTENT_KINDS that have been observed in the last 24h window. <1.0 implies emitted kinds outside the typo gate.",
        labelNames: [] as const,
      },
      [register],
    ),
    distinctIntentKindsObserved: gauge(
      {
        name: "kernel_distinct_intent_kinds_observed",
        help: "Count of distinct intent kinds the kernel observed via recordDecision in the last 24h window.",
        labelNames: [] as const,
      },
      [register],
    ),
    knownIntentKindsTotal: gauge(
      {
        name: "kernel_known_intent_kinds_total",
        help: "Total intent kinds in KNOWN_INTENT_KINDS — the typo gate's accepted set.",
        labelNames: [] as const,
      },
      [register],
    ),

    // ── W3 — close the 11 ghost metrics ───────────────────────────────

    auditLagSeconds: histogram(
      {
        name: "kernel_audit_lag_seconds",
        help: "Audit pipeline lag: time from emit() call to durable sink acknowledge, per sink.",
        labelNames: ["sink"] as const,
        buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
      },
      [register],
    ),
    replayDriftTotal: counter(
      {
        name: "kernel_replay_drift_total",
        help: "Replay-drift verdicts produced by `ibx kernel replay`. One increment per drift event.",
        labelNames: ["class"] as const,
      },
      [register],
    ),
    killSwitchState: gauge(
      {
        name: "kernel_kill_switch_state",
        help: "Current kernel kill-switch state. 0 = disengaged, 1 = engaged.",
        labelNames: ["scope"] as const,
      },
      [register],
    ),
    packInstallTotal: counter(
      {
        name: "kernel_pack_install_total",
        help: "Number of `installPack` calls at boot, labelled by pack name.",
        labelNames: ["pack"] as const,
      },
      [register],
    ),
    deferPendingGauge: gauge(
      {
        name: "kernel_defer_pending_gauge",
        help: "Currently parked deferred intents (count of `defer:pending:*` Redis keys).",
        labelNames: [] as const,
      },
      [register],
    ),
    deferQuotaExceededTotal: counter(
      {
        name: "kernel_defer_quota_exceeded_total",
        help: "Per-session DEFER quota-rejection events.",
        labelNames: ["kind"] as const,
      },
      [register],
    ),
    deferTimeoutTotal: counter(
      {
        name: "kernel_defer_timeout_total",
        help: "DEFER intents that expired before their resume signal arrived (sweeper-published).",
        labelNames: ["kind"] as const,
      },
      [register],
    ),
    auditRedactorFailuresTotal: counter(
      {
        name: "kernel_audit_redactor_failures_total",
        help: "Audit-redactor fail-open events (cyclic refs, throw on traversal).",
        labelNames: ["reason"] as const,
      },
      [register],
    ),
    auditSinkBufferSize: gauge(
      {
        name: "kernel_audit_sink_buffer_size",
        help: "Current in-memory capacity usage of persistentBufferedSink (records held before spill).",
        labelNames: [] as const,
      },
      [register],
    ),
    auditSinkSpillSize: gauge(
      {
        name: "kernel_audit_sink_spill_size",
        help: "Audit Redis spill list depth (records waiting to drain to inner sinks).",
        labelNames: [] as const,
      },
      [register],
    ),
    intentKindUnknownTotal: counter(
      {
        name: "kernel_intent_kind_unknown_total",
        help: "Intents emitted with a kind that is NOT in KNOWN_INTENT_KINDS — signals taxonomy drift.",
        labelNames: ["kind"] as const,
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
  const { trackAnalytics, sentry, log, register, knownIntentKinds } = deps
  const metrics = registerMetrics(register)

  // ── W5-9: coverage gauge state ─────────────────────────────────────────
  //
  // Rolling 24h window of observed intent kinds — keyed map kind →
  // timestamp of last observation. The recordDecision hook updates this;
  // every minute we evict entries older than 24h. The gauge value is
  // recomputed every `kind observed` event so the dashboard always shows
  // the current snapshot.
  //
  // Process-local. Restarts reset the window, which is acceptable: the
  // gauge is meant for the "operator notices an intent kind being emitted
  // that's not in the typo gate" alarm, not for historical analytics
  // (that's PostHog's job).

  const observedIntentKinds = new Map<string, number>()
  const COVERAGE_WINDOW_MS = 24 * 60 * 60 * 1000

  function publishCoverageGauges(): void {
    // Evict stale entries (older than 24h).
    const now = Date.now()
    const cutoff = now - COVERAGE_WINDOW_MS
    for (const [kind, ts] of observedIntentKinds) {
      if (ts < cutoff) observedIntentKinds.delete(kind)
    }
    const observed = observedIntentKinds.size
    metrics.distinctIntentKindsObserved.set(observed)
    if (knownIntentKinds) {
      metrics.knownIntentKindsTotal.set(knownIntentKinds.size)
      // Coverage = (observed ∩ known) / |known|. The numerator counts
      // observed kinds that ARE in the typo gate — distinct from the
      // raw observation count, which can include unknown kinds.
      let knownObserved = 0
      for (const kind of observedIntentKinds.keys()) {
        if (knownIntentKinds.has(kind)) knownObserved += 1
      }
      const ratio =
        knownIntentKinds.size === 0 ? 0 : knownObserved / knownIntentKinds.size
      metrics.intentKindCoverage.set(ratio)
    }
  }

  // Publish the known total at construction time so the dashboard has
  // the denominator even before any traffic.
  if (knownIntentKinds) {
    try {
      metrics.knownIntentKindsTotal.set(knownIntentKinds.size)
      metrics.intentKindCoverage.set(0)
    } catch {
      // Defensive: registry might reject if duplicated under tests.
    }
  }

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
      // W5-9: track observed kinds for the coverage gauge.
      safeIncr("kernel_intent_kind_coverage", () => {
        observedIntentKinds.set(event.intentKind, Date.now())
        publishCoverageGauges()
      })
      // W3-11: signal taxonomy drift when an emitted kind isn't in the
      // typo gate. Only fires when knownIntentKinds is provided — without
      // the set we can't tell "unknown" from "known but rare".
      if (knownIntentKinds && !knownIntentKinds.has(event.intentKind)) {
        safeIncr("kernel_intent_kind_unknown_total", () => {
          metrics.intentKindUnknownTotal.inc({ kind: event.intentKind })
        })
      }
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
    //
    // W3-6: when the framework signals `resource: "defer_quota"`,
    // bump `kernel_defer_quota_exceeded_total{kind}`. The framework's
    // `subject` carries the sessionId; the intent kind isn't on the
    // event itself, so we label by the resource string here. Adopters
    // needing per-intent-kind granularity should invoke
    // `recordDeferQuotaExceeded(kind)` via the recorder API.
    recordResourceLimit(event: ResourceLimitEvent) {
      if (event.resource === "defer_quota") {
        safeIncr("kernel_defer_quota_exceeded_total", () => {
          metrics.deferQuotaExceededTotal.inc({ kind: event.resource })
        })
      }
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

// ── W3 — Out-of-band recorder for the 11 ghost metrics ──────────────────────
//
// The `MetricsSink` interface from `@adjudicate/core/kernel` is fixed at the
// framework boundary; we can't add new methods to it without a framework
// change. But the W3 metrics are emitted from IbateXas-side code paths the
// framework knows nothing about (sweepers, the audit-redactor wrap, Pack
// installation, the kill-switch toggle, replay CLI). So we expose a separate,
// ibatexas-internal "recorder" API that reads the same Prometheus Registry
// and mutates the same metric instances the sink populates.
//
// Callers (kernel-bootstrap, defer-timeout-sweeper, audit-redactor wrapping,
// ibx kernel replay) import `createKernelMetricsRecorder(register)` and
// invoke `record…` on it. Failure mode is the same as the sink: every
// mutation is wrapped, errors are logged via the bound logger, and never
// block the caller's code path.
//
// The recorder shares the Registry with the sink — calling registerMetrics
// twice on the same registry would throw (prom-client rejects duplicate
// names). The recorder RECOVERS the metric instances by name via
// `register.getSingleMetric(name)`. The sink constructor is the sole
// registration site.

export interface KernelMetricsRecorder {
  /** W3-1: observe audit pipeline lag (emit→ack), seconds. */
  recordAuditLag(sink: string, latencySeconds: number): void
  /** W3-2: bump replay-drift counter, labelled by drift class. */
  recordReplayDrift(driftClass: string): void
  /** W3-3: set kill-switch state (1 = engaged, 0 = disengaged). */
  recordKillSwitchState(scope: string, engaged: boolean): void
  /** W3-4: one-shot at boot — increment per installed pack. */
  recordPackInstall(pack: string): void
  /** W3-5: set the parked-envelope count (poll output). */
  recordDeferPending(count: number): void
  /** W3-6: per-session DEFER quota rejection. */
  recordDeferQuotaExceeded(kind: string): void
  /** W3-7: a sweeper-published `intent.defer.timeout` event. */
  recordDeferTimeout(kind: string): void
  /** W3-8: redactor cyclic-ref / unrecoverable error. */
  recordAuditRedactorFailure(reason: string): void
  /** W3-9: set the buffered-sink in-memory queue size. */
  recordAuditSinkBufferSize(count: number): void
  /** W3-10: set the Redis spill list depth. */
  recordAuditSinkSpillSize(count: number): void
  /** W3-11: an intent kind was emitted that's not in KNOWN_INTENT_KINDS. */
  recordIntentKindUnknown(kind: string): void
}

/**
 * Build the W3 recorder against an already-constructed Registry. The Registry
 * MUST be the same one passed to `createKernelMetricsSink({ register })` so
 * the recorder mutates the same metric instances the sink published.
 *
 * Fail-mode: every operation is wrapped; errors logged via `log` (or
 * `console.warn`); never throws.
 */
export function createKernelMetricsRecorder(
  register: Registry,
  log: MetricsSinkLogger = { warn: (o, m) => console.warn(m, o) },
): KernelMetricsRecorder {
  function get<T>(name: string): T | null {
    const m = register.getSingleMetric(name)
    if (m === undefined) {
      log.warn(
        { metric: name },
        "kernel-metrics-recorder: metric not registered — recorder operation no-op",
      )
      return null
    }
    return m as unknown as T
  }

  const safe = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      log.warn(
        { err: serializeError(err), metric: label },
        "kernel-metrics-recorder: mutation threw",
      )
    }
  }

  return {
    recordAuditLag(sink, latencySeconds) {
      const h = get<Histogram<"sink">>("kernel_audit_lag_seconds")
      if (!h) return
      safe("kernel_audit_lag_seconds", () => h.observe({ sink }, latencySeconds))
    },
    recordReplayDrift(driftClass) {
      const c = get<Counter<"class">>("kernel_replay_drift_total")
      if (!c) return
      safe("kernel_replay_drift_total", () => c.inc({ class: driftClass }))
    },
    recordKillSwitchState(scope, engaged) {
      const g = get<Gauge<"scope">>("kernel_kill_switch_state")
      if (!g) return
      safe("kernel_kill_switch_state", () => g.set({ scope }, engaged ? 1 : 0))
    },
    recordPackInstall(pack) {
      const c = get<Counter<"pack">>("kernel_pack_install_total")
      if (!c) return
      safe("kernel_pack_install_total", () => c.inc({ pack }))
    },
    recordDeferPending(count) {
      const g = get<Gauge<never>>("kernel_defer_pending_gauge")
      if (!g) return
      safe("kernel_defer_pending_gauge", () => g.set(count))
    },
    recordDeferQuotaExceeded(kind) {
      const c = get<Counter<"kind">>("kernel_defer_quota_exceeded_total")
      if (!c) return
      safe("kernel_defer_quota_exceeded_total", () => c.inc({ kind }))
    },
    recordDeferTimeout(kind) {
      const c = get<Counter<"kind">>("kernel_defer_timeout_total")
      if (!c) return
      safe("kernel_defer_timeout_total", () => c.inc({ kind }))
    },
    recordAuditRedactorFailure(reason) {
      const c = get<Counter<"reason">>("kernel_audit_redactor_failures_total")
      if (!c) return
      safe("kernel_audit_redactor_failures_total", () => c.inc({ reason }))
    },
    recordAuditSinkBufferSize(count) {
      const g = get<Gauge<never>>("kernel_audit_sink_buffer_size")
      if (!g) return
      safe("kernel_audit_sink_buffer_size", () => g.set(count))
    },
    recordAuditSinkSpillSize(count) {
      const g = get<Gauge<never>>("kernel_audit_sink_spill_size")
      if (!g) return
      safe("kernel_audit_sink_spill_size", () => g.set(count))
    },
    recordIntentKindUnknown(kind) {
      const c = get<Counter<"kind">>("kernel_intent_kind_unknown_total")
      if (!c) return
      safe("kernel_intent_kind_unknown_total", () => c.inc({ kind }))
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
