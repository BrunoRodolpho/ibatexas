// Unit tests for the kernel MetricsSink adapter.
//
// Pure unit-tests: no NATS, no Sentry SDK, no Fastify. Every dep is injected
// (TrackAnalytics, sentry, log, register) so we can assert exact fan-out per
// the task table.
//
// The Fastify-flavoured tests at the bottom cover the /metrics route (503
// when PROMETHEUS_TOKEN unset; 200 + prom text when token matches).

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest"
import Fastify from "fastify"
import { Registry } from "prom-client"
import type {
  DecisionEvent,
  LedgerOpEvent,
  RefusalEvent,
  ShadowDivergenceEvent,
  SinkFailureEvent,
} from "@adjudicate/core/kernel"
import {
  createKernelMetricsRecorder,
  createKernelMetricsSink,
  type KernelMetricsSinkDeps,
  type MetricsSinkLogger,
  type TrackAnalytics,
} from "../kernel-metrics-sink.js"
import { metricsRoutes } from "../../routes/metrics.js"

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeDeps(
  overrides?: Partial<KernelMetricsSinkDeps>,
): {
  deps: KernelMetricsSinkDeps
  track: ReturnType<typeof vi.fn>
  breadcrumb: ReturnType<typeof vi.fn>
  log: MetricsSinkLogger
  register: Registry
} {
  const track = vi.fn<TrackAnalytics>(() => undefined)
  const breadcrumb = vi.fn()
  const log: MetricsSinkLogger = {
    warn: vi.fn(),
    debug: vi.fn(),
  }
  const register = new Registry()
  const deps: KernelMetricsSinkDeps = {
    trackAnalytics: overrides?.trackAnalytics ?? track,
    sentry: overrides?.sentry ?? { addBreadcrumb: breadcrumb },
    log: overrides?.log ?? log,
    register: overrides?.register ?? register,
    ...(overrides?.knownIntentKinds !== undefined
      ? { knownIntentKinds: overrides.knownIntentKinds }
      : {}),
  }
  return { deps, track, breadcrumb, log, register }
}

function mkDecision(
  decision: DecisionEvent["decision"],
  overrides?: Partial<DecisionEvent>,
): DecisionEvent {
  return {
    intentKind: "order.confirm",
    decision,
    latencyMs: 12,
    basisCount: 3,
    intentHash: "deadbeefcafebabe1234567890abcdef",
    ...overrides,
  }
}

function mkRefusal(): RefusalEvent {
  return {
    intentKind: "order.cancel",
    refusal: {
      kind: "BUSINESS_RULE",
      code: "ponr.window_closed",
      userFacing: "Pedido já confirmado — não pode mais ser alterado.",
    },
    intentHash: "abc1234567890abcdef1234567890abcd",
  }
}

function mkLedgerOp(overrides?: Partial<LedgerOpEvent>): LedgerOpEvent {
  return {
    op: "check",
    outcome: "hit",
    intentKind: "order.confirm",
    latencyMs: 4,
    ...overrides,
  }
}

function mkSinkFailure(): SinkFailureEvent {
  return {
    sink: "nats",
    subject: "ibatexas.audit.intent.decision.v1",
    errorClass: "ConnectionClosed",
    consecutiveFailures: 3,
  }
}

function mkShadowDivergence(
  cls: ShadowDivergenceEvent["divergence"],
): ShadowDivergenceEvent {
  return {
    intentKind: "payment.refund.issue",
    divergence: cls,
    legacy: { kind: "EXECUTE" },
    adjudicate: { kind: "REFUSE", refusal: mkRefusal().refusal, basis: [] },
  }
}

// ── recordDecision ───────────────────────────────────────────────────────────

describe("createKernelMetricsSink — recordDecision", () => {
  it("EXECUTE fires audit_decision_executed with intent_kind", () => {
    const { deps, track } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(mkDecision("EXECUTE", { intentKind: "order.cancel" }))
    expect(track).toHaveBeenCalledWith(
      "audit_decision_executed",
      expect.objectContaining({
        intent_kind: "order.cancel",
        decision_kind: "EXECUTE",
      }),
    )
  })

  it.each(["REFUSE", "ESCALATE", "REQUEST_CONFIRMATION", "DEFER", "REWRITE"] as const)(
    "%s decision fires audit_decision_refused",
    (kind) => {
      const { deps, track } = makeDeps()
      const sink = createKernelMetricsSink(deps)
      sink.recordDecision(mkDecision(kind))
      expect(track).toHaveBeenCalledWith(
        "audit_decision_refused",
        expect.objectContaining({ decision_kind: kind }),
      )
    },
  )

  it("Prometheus counter kernel_decision_total increments on recordDecision", async () => {
    const { deps, register } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(mkDecision("EXECUTE", { intentKind: "order.confirm" }))
    sink.recordDecision(mkDecision("EXECUTE", { intentKind: "order.confirm" }))
    sink.recordDecision(mkDecision("REFUSE", { intentKind: "order.confirm" }))
    const json = await register.getSingleMetricAsString("kernel_decision_total")
    expect(json).toContain(
      `kernel_decision_total{kind="EXECUTE",intent_kind="order.confirm"} 2`,
    )
    expect(json).toContain(
      `kernel_decision_total{kind="REFUSE",intent_kind="order.confirm"} 1`,
    )
  })

  it("records decision duration in seconds (not ms)", async () => {
    const { deps, register } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(
      mkDecision("EXECUTE", { intentKind: "order.confirm", latencyMs: 250 }),
    )
    const out = await register.getSingleMetricAsString(
      "kernel_decision_duration_seconds",
    )
    // 250ms → 0.25s should fall in the 0.5 bucket but not 0.1.
    expect(out).toMatch(/kernel_decision_duration_seconds_bucket{le="0\.5"[^}]*} 1/)
    expect(out).toMatch(/kernel_decision_duration_seconds_sum.*0\.25/)
  })

  it("does NOT fire a Sentry breadcrumb on recordDecision (volume guard)", () => {
    const { deps, breadcrumb } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(mkDecision("EXECUTE"))
    sink.recordDecision(mkDecision("REFUSE"))
    expect(breadcrumb).not.toHaveBeenCalled()
  })
})

// ── W5-9: coverage gauge ─────────────────────────────────────────────────────

describe("createKernelMetricsSink — kernel_intent_kind_coverage gauge (W5-9)", () => {
  it("publishes 0 ratio when no decisions observed yet", async () => {
    const { deps, register } = makeDeps({
      knownIntentKinds: new Set(["order.item.add", "payment.refund.issue"]),
    })
    createKernelMetricsSink(deps)
    const out = await register.getSingleMetricAsString(
      "kernel_intent_kind_coverage",
    )
    expect(out).toMatch(/kernel_intent_kind_coverage\s+0/)
  })

  it("publishes ratio based on observed-vs-known kinds", async () => {
    const { deps, register } = makeDeps({
      knownIntentKinds: new Set([
        "order.item.add",
        "order.cancel",
        "payment.refund.issue",
        "payment.charge.confirm",
      ]),
    })
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(
      mkDecision("EXECUTE", { intentKind: "order.item.add" }),
    )
    sink.recordDecision(
      mkDecision("EXECUTE", { intentKind: "order.cancel" }),
    )
    const out = await register.getSingleMetricAsString(
      "kernel_intent_kind_coverage",
    )
    // 2 of 4 known kinds observed → 0.5
    expect(out).toMatch(/kernel_intent_kind_coverage\s+0\.5/)
  })

  it("publishes total known kinds gauge", async () => {
    const { deps, register } = makeDeps({
      knownIntentKinds: new Set([
        "order.item.add",
        "payment.refund.issue",
        "reservation.create",
      ]),
    })
    createKernelMetricsSink(deps)
    const out = await register.getSingleMetricAsString(
      "kernel_known_intent_kinds_total",
    )
    expect(out).toMatch(/kernel_known_intent_kinds_total\s+3/)
  })

  it("tracks distinct observed kinds (deduped within window)", async () => {
    const { deps, register } = makeDeps({
      knownIntentKinds: new Set(["order.item.add"]),
    })
    const sink = createKernelMetricsSink(deps)
    // Same kind 3 times → distinct count = 1
    sink.recordDecision(mkDecision("EXECUTE", { intentKind: "order.item.add" }))
    sink.recordDecision(mkDecision("EXECUTE", { intentKind: "order.item.add" }))
    sink.recordDecision(mkDecision("REFUSE", { intentKind: "order.item.add" }))
    const out = await register.getSingleMetricAsString(
      "kernel_distinct_intent_kinds_observed",
    )
    expect(out).toMatch(/kernel_distinct_intent_kinds_observed\s+1/)
  })

  it("flags unknown kinds — observed but not in KNOWN_INTENT_KINDS doesn't lift coverage", async () => {
    const { deps, register } = makeDeps({
      knownIntentKinds: new Set(["order.item.add", "payment.refund.issue"]),
    })
    const sink = createKernelMetricsSink(deps)
    // An unknown kind leaks through. Coverage stays at 0 because no
    // known kind has been observed.
    sink.recordDecision(
      mkDecision("EXECUTE", { intentKind: "rogue.unknown.kind" }),
    )
    const out = await register.getSingleMetricAsString(
      "kernel_intent_kind_coverage",
    )
    expect(out).toMatch(/kernel_intent_kind_coverage\s+0/)
    // But the distinct-observed gauge DOES count the unknown (so the
    // operator can compare observed vs known directly).
    const observed = await register.getSingleMetricAsString(
      "kernel_distinct_intent_kinds_observed",
    )
    expect(observed).toMatch(/kernel_distinct_intent_kinds_observed\s+1/)
  })

  it("works without knownIntentKinds (coverage stays at 0; counters still publish)", async () => {
    const { deps, register } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(mkDecision("EXECUTE", { intentKind: "order.item.add" }))
    const out = await register.getSingleMetricAsString(
      "kernel_distinct_intent_kinds_observed",
    )
    expect(out).toMatch(/kernel_distinct_intent_kinds_observed\s+1/)
  })
})

// ── recordRefusal ────────────────────────────────────────────────────────────

describe("createKernelMetricsSink — recordRefusal", () => {
  it("fires a Sentry breadcrumb with category audit_refused", () => {
    const { deps, breadcrumb } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordRefusal(mkRefusal())
    expect(breadcrumb).toHaveBeenCalledTimes(1)
    expect(breadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "audit_refused",
        level: "warning",
        data: expect.objectContaining({
          intent_kind: "order.cancel",
          refusal_kind: "BUSINESS_RULE",
          refusal_code: "ponr.window_closed",
        }),
      }),
    )
  })

  it("does NOT emit a PostHog event (it's folded into recordDecision)", () => {
    const { deps, track } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordRefusal(mkRefusal())
    expect(track).not.toHaveBeenCalled()
  })

  it("increments kernel_refusal_total", async () => {
    const { deps, register } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordRefusal(mkRefusal())
    const out = await register.getSingleMetricAsString("kernel_refusal_total")
    expect(out).toContain(`basis_code="ponr.window_closed"`)
  })
})

// ── recordSinkFailure ────────────────────────────────────────────────────────

describe("createKernelMetricsSink — recordSinkFailure", () => {
  it("fires Sentry breadcrumb with category sink_failure", () => {
    const { deps, breadcrumb } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordSinkFailure(mkSinkFailure())
    expect(breadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "sink_failure", level: "warning" }),
    )
  })

  it("escalates breadcrumb to error level past 10 consecutive failures", () => {
    const { deps, breadcrumb } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordSinkFailure({ ...mkSinkFailure(), consecutiveFailures: 11 })
    expect(breadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "sink_failure", level: "error" }),
    )
  })

  it("fires PostHog audit_nats_sink_failed", () => {
    const { deps, track } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordSinkFailure(mkSinkFailure())
    expect(track).toHaveBeenCalledWith(
      "audit_nats_sink_failed",
      expect.objectContaining({ sink: "nats", error_class: "ConnectionClosed" }),
    )
  })

  it("increments kernel_audit_sink_failure_total", async () => {
    const { deps, register } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordSinkFailure(mkSinkFailure())
    const out = await register.getSingleMetricAsString(
      "kernel_audit_sink_failure_total",
    )
    expect(out).toContain(`sink="nats"`)
    expect(out).toContain(`reason="ConnectionClosed"`)
  })
})

// ── recordShadowDivergence ───────────────────────────────────────────────────
//
// IBX-IGE v3.0 cutover (f3bea43): shadow-mode plumbing was removed —
// `recordShadowDivergence` is a no-op retained only to satisfy the
// `MetricsSink` interface contract. The legacy PostHog events and the
// `kernel_shadow_divergence_total` Prometheus counter were retired.

describe("createKernelMetricsSink — recordShadowDivergence (no-op)", () => {
  it("does not emit any PostHog event", () => {
    const { deps, track } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordShadowDivergence(mkShadowDivergence("DECISION_KIND"))
    expect(track).not.toHaveBeenCalled()
  })

  it("does not fire a Sentry breadcrumb", () => {
    const { deps, breadcrumb } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordShadowDivergence(mkShadowDivergence("DECISION_KIND"))
    expect(breadcrumb).not.toHaveBeenCalled()
  })

  it("does not register kernel_shadow_divergence_total", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const metric = register.getSingleMetric("kernel_shadow_divergence_total")
    expect(metric).toBeUndefined()
  })
})

// ── recordLedgerOp ───────────────────────────────────────────────────────────

describe("createKernelMetricsSink — recordLedgerOp", () => {
  it("emits audit_ledger_hit only on hit (suppresses miss)", () => {
    const { deps, track } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordLedgerOp(mkLedgerOp({ outcome: "hit" }))
    sink.recordLedgerOp(mkLedgerOp({ outcome: "miss" }))
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith(
      "audit_ledger_hit",
      expect.objectContaining({ op: "check", outcome: "hit" }),
    )
  })

  it("increments kernel_ledger_op_total on every op regardless of outcome", async () => {
    const { deps, register } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordLedgerOp(mkLedgerOp({ outcome: "hit" }))
    sink.recordLedgerOp(mkLedgerOp({ outcome: "miss" }))
    sink.recordLedgerOp(mkLedgerOp({ outcome: "error" }))
    const out = await register.getSingleMetricAsString("kernel_ledger_op_total")
    expect(out).toContain(`outcome="hit"`)
    expect(out).toContain(`outcome="miss"`)
    expect(out).toContain(`outcome="error"`)
  })
})

// ── Fail-open semantics ──────────────────────────────────────────────────────

describe("createKernelMetricsSink — fail-open", () => {
  it("never throws when trackAnalytics rejects", () => {
    const track = vi.fn(() => Promise.reject(new Error("nats down")))
    const { deps, log } = makeDeps({ trackAnalytics: track })
    const sink = createKernelMetricsSink(deps)
    // Run all six methods — none should throw.
    expect(() => {
      sink.recordDecision(mkDecision("EXECUTE"))
      sink.recordRefusal(mkRefusal())
      sink.recordSinkFailure(mkSinkFailure())
      sink.recordShadowDivergence(mkShadowDivergence("BASIS_ONLY"))
      sink.recordLedgerOp(mkLedgerOp())
      sink.recordResourceLimit?.({
        resource: "defer_quota",
        subject: "sess-1",
        limit: 10,
        observed: 11,
      })
    }).not.toThrow()
    // Give the rejected promise a tick.
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: expect.any(String) }),
          expect.stringContaining("analytics publish rejected"),
        )
        resolve()
      }),
    )
  })

  it("never throws when trackAnalytics synchronously throws", () => {
    const track = vi.fn(() => {
      throw new Error("sync boom")
    })
    const { deps, log } = makeDeps({ trackAnalytics: track })
    const sink = createKernelMetricsSink(deps)
    expect(() => sink.recordDecision(mkDecision("EXECUTE"))).not.toThrow()
    expect(log.warn).toHaveBeenCalled()
  })

  it("never throws when sentry.addBreadcrumb throws", () => {
    const breadcrumb = vi.fn(() => {
      throw new Error("sentry boom")
    })
    const { deps, log } = makeDeps({ sentry: { addBreadcrumb: breadcrumb } })
    const sink = createKernelMetricsSink(deps)
    expect(() => sink.recordRefusal(mkRefusal())).not.toThrow()
    expect(log.warn).toHaveBeenCalled()
  })
})

// ── /metrics route ───────────────────────────────────────────────────────────

describe("metricsRoutes — GET /metrics", () => {
  const originalToken = process.env.PROMETHEUS_TOKEN

  beforeEach(() => {
    process.env.PROMETHEUS_TOKEN = originalToken
  })

  it("returns 503 when PROMETHEUS_TOKEN is unset", async () => {
    delete process.env.PROMETHEUS_TOKEN
    const server = Fastify({ logger: false })
    const register = new Registry()
    await server.register(metricsRoutes({ register }))
    await server.ready()
    const res = await server.inject({ method: "GET", url: "/metrics" })
    expect(res.statusCode).toBe(503)
    await server.close()
  })

  it("returns 401 when token header mismatches", async () => {
    process.env.PROMETHEUS_TOKEN = "secret-abc"
    const server = Fastify({ logger: false })
    const register = new Registry()
    await server.register(metricsRoutes({ register }))
    await server.ready()
    const res = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-prometheus-token": "wrong" },
    })
    expect(res.statusCode).toBe(401)
    await server.close()
  })

  it("returns 200 with Prometheus text-format when token matches", async () => {
    process.env.PROMETHEUS_TOKEN = "secret-xyz"
    const server = Fastify({ logger: false })
    const register = new Registry()
    // Populate the registry through the sink so we have at least one metric.
    const { deps } = makeDeps({ register })
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(mkDecision("EXECUTE"))
    await server.register(metricsRoutes({ register }))
    await server.ready()
    const res = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-prometheus-token": "secret-xyz" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/plain")
    expect(res.body).toContain("kernel_decision_total")
    await server.close()
  })
})

// ── W3 — the 10 previously-ghost metrics ─────────────────────────────────────
//
// Each test asserts: (1) the metric registers with the expected name +
// labels; (2) the recorder's mutation surfaces on the registry text dump.
// `createKernelMetricsSink(...)` is what registers the metrics; the
// recorder reuses the same Registry.

describe("createKernelMetricsSink — W3 ghost metrics registration", () => {
  const NAMES = [
    "kernel_audit_lag_seconds",
    "kernel_replay_drift_total",
    "kernel_pack_install_total",
    "kernel_defer_pending_gauge",
    "kernel_defer_quota_exceeded_total",
    "kernel_defer_timeout_total",
    "kernel_audit_redactor_failures_total",
    "kernel_audit_sink_buffer_size",
    "kernel_audit_sink_spill_size",
    "kernel_intent_kind_unknown_total",
  ] as const

  it.each(NAMES)("registers %s on the shared registry", async (name) => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const metric = register.getSingleMetric(name)
    expect(metric).toBeDefined()
    // prom-client's Metric type doesn't expose `name` on the public
    // interface; cast through unknown to access it for the assertion.
    expect((metric as unknown as { name: string } | undefined)?.name).toBe(
      name,
    )
  })

  it("kernel_audit_lag_seconds — recorder.recordAuditLag observes per sink", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordAuditLag("postgres", 0.42)
    recorder.recordAuditLag("nats", 0.05)
    const out = await register.getSingleMetricAsString("kernel_audit_lag_seconds")
    expect(out).toContain(`sink="postgres"`)
    expect(out).toContain(`sink="nats"`)
    expect(out).toMatch(/kernel_audit_lag_seconds_sum.*0\.4\d/)
  })

  it("kernel_replay_drift_total — recorder.recordReplayDrift labels by class", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordReplayDrift("regressing")
    recorder.recordReplayDrift("regressing")
    recorder.recordReplayDrift("stable")
    const out = await register.getSingleMetricAsString("kernel_replay_drift_total")
    expect(out).toContain(`kernel_replay_drift_total{class="regressing"} 2`)
    expect(out).toContain(`kernel_replay_drift_total{class="stable"} 1`)
  })

  it("kernel_pack_install_total — recorder.recordPackInstall labels by pack", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordPackInstall("orders")
    recorder.recordPackInstall("payments")
    recorder.recordPackInstall("payments")
    const out = await register.getSingleMetricAsString("kernel_pack_install_total")
    expect(out).toContain(`kernel_pack_install_total{pack="orders"} 1`)
    expect(out).toContain(`kernel_pack_install_total{pack="payments"} 2`)
  })

  it("kernel_defer_pending_gauge — recorder.recordDeferPending sets the value", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordDeferPending(7)
    let out = await register.getSingleMetricAsString("kernel_defer_pending_gauge")
    expect(out).toMatch(/kernel_defer_pending_gauge\s+7/)
    recorder.recordDeferPending(3)
    out = await register.getSingleMetricAsString("kernel_defer_pending_gauge")
    expect(out).toMatch(/kernel_defer_pending_gauge\s+3/)
  })

  it("kernel_defer_quota_exceeded_total — recorder.recordDeferQuotaExceeded labels by kind", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordDeferQuotaExceeded("order.checkout.create")
    recorder.recordDeferQuotaExceeded("order.checkout.create")
    recorder.recordDeferQuotaExceeded("payment.pix.regenerate")
    const out = await register.getSingleMetricAsString(
      "kernel_defer_quota_exceeded_total",
    )
    expect(out).toContain(
      `kernel_defer_quota_exceeded_total{kind="order.checkout.create"} 2`,
    )
    expect(out).toContain(
      `kernel_defer_quota_exceeded_total{kind="payment.pix.regenerate"} 1`,
    )
  })

  it("kernel_defer_timeout_total — recorder.recordDeferTimeout labels by kind", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordDeferTimeout("pix.confirmed")
    recorder.recordDeferTimeout("pix.confirmed")
    const out = await register.getSingleMetricAsString(
      "kernel_defer_timeout_total",
    )
    expect(out).toContain(`kernel_defer_timeout_total{kind="pix.confirmed"} 2`)
  })

  it("kernel_audit_redactor_failures_total — recorder.recordAuditRedactorFailure labels by reason", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordAuditRedactorFailure("cycle")
    recorder.recordAuditRedactorFailure("throw")
    recorder.recordAuditRedactorFailure("cycle")
    const out = await register.getSingleMetricAsString(
      "kernel_audit_redactor_failures_total",
    )
    expect(out).toContain(
      `kernel_audit_redactor_failures_total{reason="cycle"} 2`,
    )
    expect(out).toContain(
      `kernel_audit_redactor_failures_total{reason="throw"} 1`,
    )
  })

  it("kernel_audit_sink_buffer_size — recorder.recordAuditSinkBufferSize sets the value", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordAuditSinkBufferSize(128)
    const out = await register.getSingleMetricAsString(
      "kernel_audit_sink_buffer_size",
    )
    expect(out).toMatch(/kernel_audit_sink_buffer_size\s+128/)
  })

  it("kernel_audit_sink_spill_size — recorder.recordAuditSinkSpillSize sets the value", async () => {
    const { deps, register } = makeDeps()
    createKernelMetricsSink(deps)
    const recorder = createKernelMetricsRecorder(register)
    recorder.recordAuditSinkSpillSize(42)
    const out = await register.getSingleMetricAsString(
      "kernel_audit_sink_spill_size",
    )
    expect(out).toMatch(/kernel_audit_sink_spill_size\s+42/)
  })

  it("kernel_intent_kind_unknown_total — sink emits on unknown kind via recordDecision", async () => {
    const { deps, register } = makeDeps({
      knownIntentKinds: new Set(["order.item.add", "payment.refund.issue"]),
    })
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(
      mkDecision("EXECUTE", { intentKind: "rogue.unknown.kind" }),
    )
    sink.recordDecision(
      mkDecision("EXECUTE", { intentKind: "rogue.unknown.kind" }),
    )
    // Known kind doesn't increment.
    sink.recordDecision(
      mkDecision("EXECUTE", { intentKind: "order.item.add" }),
    )
    const out = await register.getSingleMetricAsString(
      "kernel_intent_kind_unknown_total",
    )
    expect(out).toContain(
      `kernel_intent_kind_unknown_total{kind="rogue.unknown.kind"} 2`,
    )
    expect(out).not.toContain(`kind="order.item.add"`)
  })

  it("kernel_intent_kind_unknown_total — no emission when knownIntentKinds is absent", async () => {
    const { deps, register } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordDecision(
      mkDecision("EXECUTE", { intentKind: "rogue.unknown.kind" }),
    )
    const out = await register.getSingleMetricAsString(
      "kernel_intent_kind_unknown_total",
    )
    // Metric registers (empty), no sample lines for any kind.
    expect(out).not.toContain(`kernel_intent_kind_unknown_total{kind=`)
  })

  it("/metrics scrape exposes ALL 11 W3 ghost metrics", async () => {
    process.env.PROMETHEUS_TOKEN = "secret-w3"
    const server = Fastify({ logger: false })
    const register = new Registry()
    const { deps } = makeDeps({ register })
    createKernelMetricsSink(deps)
    await server.register(metricsRoutes({ register }))
    await server.ready()
    const res = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-prometheus-token": "secret-w3" },
    })
    expect(res.statusCode).toBe(200)
    for (const name of NAMES) {
      expect(res.body).toContain(`# TYPE ${name}`)
    }
    await server.close()
  })
})

// ── Recorder — fail-open semantics ─────────────────────────────────────────

describe("createKernelMetricsRecorder — fail-open", () => {
  it("warns and no-ops when called against a Registry without the metric", () => {
    const register = new Registry()
    const warn = vi.fn()
    const recorder = createKernelMetricsRecorder(register, {
      warn,
      debug: vi.fn(),
    })
    // No sink ever ran, so the metric isn't registered. The recorder
    // should log a warning and not throw.
    expect(() => recorder.recordPackInstall("orders")).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ metric: "kernel_pack_install_total" }),
      expect.stringContaining("not registered"),
    )
  })
})
