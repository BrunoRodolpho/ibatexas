import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetMetricsSink,
  createConsoleMetricsSink,
  recordDecision,
  recordLedgerOp,
  recordRefusal,
  recordSinkFailure,
  setMetricsSink,
  type MetricsSink,
} from "../intent-metrics.js"
import {
  _resetShadowTelemetrySink,
  adjudicateWithShadow,
  type LegacyDecisionResult,
} from "../intent-shadow.js"
import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionRefuse,
  refuse,
} from "@adjudicate/intent-core"
import type { PolicyBundle } from "@adjudicate/intent-kernel"

describe("intent-metrics — sink dispatch", () => {
  let sink: MetricsSink
  let calls: Array<{ method: string; args: unknown[] }>

  beforeEach(() => {
    calls = []
    sink = {
      recordLedgerOp: (...args) =>
        calls.push({ method: "recordLedgerOp", args }),
      recordDecision: (...args) =>
        calls.push({ method: "recordDecision", args }),
      recordRefusal: (...args) =>
        calls.push({ method: "recordRefusal", args }),
      recordSinkFailure: (...args) =>
        calls.push({ method: "recordSinkFailure", args }),
      recordShadowDivergence: (...args) =>
        calls.push({ method: "recordShadowDivergence", args }),
    }
    setMetricsSink(sink)
  })

  afterEach(() => {
    _resetMetricsSink()
    _resetShadowTelemetrySink()
  })

  it("recordLedgerOp routes to sink", () => {
    recordLedgerOp({
      op: "check",
      outcome: "hit",
      intentKind: "order.submit",
      latencyMs: 3,
    })
    expect(calls).toEqual([
      { method: "recordLedgerOp", args: [{ op: "check", outcome: "hit", intentKind: "order.submit", latencyMs: 3 }] },
    ])
  })

  it("recordDecision routes to sink", () => {
    recordDecision({
      intentKind: "order.submit",
      decision: "EXECUTE",
      latencyMs: 1,
      basisCount: 5,
      intentHash: "h",
    })
    expect(calls[0]!.method).toBe("recordDecision")
  })

  it("recordRefusal routes to sink", () => {
    recordRefusal({
      intentKind: "payment.send",
      refusal: { kind: "SECURITY", code: "x", userFacing: "y" },
      intentHash: "h",
    })
    expect(calls[0]!.method).toBe("recordRefusal")
  })

  it("recordSinkFailure routes to sink", () => {
    recordSinkFailure({
      sink: "nats",
      subject: "audit.intent.decision.v1",
      errorClass: "NatsTimeoutError",
      consecutiveFailures: 3,
    })
    expect(calls[0]!.method).toBe("recordSinkFailure")
  })

  it("setMetricsSink also wires shadow telemetry through the same sink", () => {
    // Triggering a shadow divergence should land on recordShadowDivergence
    const policy: PolicyBundle<string, unknown, unknown> = {
      stateGuards: [],
      authGuards: [],
      taint: { minimumFor: () => "SYSTEM" },
      business: [],
      default: "EXECUTE",
    }
    const env = buildEnvelope({
      kind: "payment.send",
      payload: {},
      actor: { principal: "llm", sessionId: "s" },
      taint: "UNTRUSTED", // forces taint refusal
      createdAt: "2026-04-23T12:00:00.000Z",
    })
    adjudicateWithShadow({
      envelope: env,
      state: {},
      policy,
      legacy: () => true, // legacy EXECUTE diverges from kernel REFUSE → DECISION_KIND
    })
    const divergence = calls.find((c) => c.method === "recordShadowDivergence")
    expect(divergence).toBeDefined()
    const event = (divergence!.args[0] as { divergence: string; intentKind: string })
    expect(event.divergence).toBe("DECISION_KIND")
    expect(event.intentKind).toBe("payment.send")
  })
})

describe("createConsoleMetricsSink", () => {
  it("emits ledger ops via console.log", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const sink = createConsoleMetricsSink()
    sink.recordLedgerOp({
      op: "check",
      outcome: "hit",
      intentKind: "x",
      latencyMs: 1,
    })
    expect(log).toHaveBeenCalledOnce()
    log.mockRestore()
  })

  it("emits refusals via console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sink = createConsoleMetricsSink()
    sink.recordRefusal({
      intentKind: "x",
      refusal: { kind: "SECURITY", code: "y", userFacing: "z" },
      intentHash: "abc12345abc12345",
    })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it("emits sink failures via console.error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const sink = createConsoleMetricsSink()
    sink.recordSinkFailure({
      sink: "nats",
      subject: "x",
      errorClass: "y",
      consecutiveFailures: 1,
    })
    expect(err).toHaveBeenCalledOnce()
    err.mockRestore()
  })

  it("BASIS_ONLY shadow divergence uses console.log (metric only, not page-worthy)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sink = createConsoleMetricsSink()
    sink.recordShadowDivergence({
      intentKind: "x",
      divergence: "BASIS_ONLY",
      legacy: { kind: "EXECUTE" } as LegacyDecisionResult,
      adjudicate: { kind: "EXECUTE", basis: [basis("state", BASIS_CODES.state.TRANSITION_VALID)] },
    })
    expect(log).toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    log.mockRestore()
    warn.mockRestore()
  })

  it("DECISION_KIND shadow divergence uses console.warn (page-worthy)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sink = createConsoleMetricsSink()
    sink.recordShadowDivergence({
      intentKind: "x",
      divergence: "DECISION_KIND",
      legacy: { kind: "EXECUTE" } as LegacyDecisionResult,
      adjudicate: decisionRefuse(refuse("STATE", "x", "y"), []),
    })
    expect(warn).toHaveBeenCalled()
    log.mockRestore()
    warn.mockRestore()
  })
})
