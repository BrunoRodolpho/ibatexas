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

describe("createKernelMetricsSink — recordShadowDivergence", () => {
  it.each([
    ["BASIS_ONLY", "audit_kernel_shadow_diverged_basis"],
    ["DECISION_KIND", "audit_kernel_shadow_diverged_kind"],
    ["PAYLOAD_REWRITE", "audit_kernel_shadow_diverged_rewrite"],
  ] as const)("%s emits %s", (cls, expectedEvent) => {
    const { deps, track } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordShadowDivergence(mkShadowDivergence(cls))
    expect(track).toHaveBeenCalledWith(
      expectedEvent,
      expect.objectContaining({ divergence_class: cls }),
    )
  })

  it("does NOT fire a Sentry breadcrumb (metrics-only per task table)", () => {
    const { deps, breadcrumb } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordShadowDivergence(mkShadowDivergence("DECISION_KIND"))
    expect(breadcrumb).not.toHaveBeenCalled()
  })

  it("increments kernel_shadow_divergence_total", async () => {
    const { deps, register } = makeDeps()
    const sink = createKernelMetricsSink(deps)
    sink.recordShadowDivergence(mkShadowDivergence("BASIS_ONLY"))
    const out = await register.getSingleMetricAsString(
      "kernel_shadow_divergence_total",
    )
    expect(out).toContain(`class="BASIS_ONLY"`)
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
