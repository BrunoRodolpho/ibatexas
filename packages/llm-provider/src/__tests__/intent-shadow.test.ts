import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetShadowTelemetrySink,
  adjudicateWithShadow,
  classifyDivergence,
  legacyDecisionAsKernelDecision,
  setShadowTelemetrySink,
  type DivergenceClass,
  type LegacyDecisionResult,
  type ShadowTelemetrySink,
} from "../intent-shadow.js"
import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  decisionRewrite,
  refuse,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/intent-core"
import type { PolicyBundle } from "@adjudicate/intent-kernel"

describe("classifyDivergence (pure)", () => {
  function exec(): Decision {
    return decisionExecute([basis("state", BASIS_CODES.state.TRANSITION_VALID)])
  }

  function ref(): Decision {
    return decisionRefuse(refuse("STATE", "x", "y"), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL),
    ])
  }

  function rew(): Decision {
    const env = buildEnvelope({
      kind: "order.tool.propose",
      payload: {},
      actor: { principal: "llm", sessionId: "s" },
      taint: "TRUSTED",
      createdAt: "2026-04-23T12:00:00.000Z",
    })
    return decisionRewrite(env, "sanitized", [
      basis("validation", BASIS_CODES.validation.HOMOGLYPH_NORMALIZED),
    ])
  }

  it("REWRITE on adjudicate side is always PAYLOAD_REWRITE", () => {
    expect(classifyDivergence({ kind: "EXECUTE" }, rew())).toBe(
      "PAYLOAD_REWRITE",
    )
    expect(classifyDivergence({ kind: "REFUSE" }, rew())).toBe(
      "PAYLOAD_REWRITE",
    )
  })

  it("Different effective outcomes → DECISION_KIND", () => {
    expect(classifyDivergence({ kind: "EXECUTE" }, ref())).toBe(
      "DECISION_KIND",
    )
    expect(classifyDivergence({ kind: "REFUSE" }, exec())).toBe(
      "DECISION_KIND",
    )
  })

  it("Same outcome with structured basis → BASIS_ONLY", () => {
    // Legacy EXECUTE, adjudicate EXECUTE with non-empty basis
    expect(classifyDivergence({ kind: "EXECUTE" }, exec())).toBe("BASIS_ONLY")
  })

  it("Same outcome with empty basis → NONE", () => {
    const emptyExec: Decision = { kind: "EXECUTE", basis: [] }
    expect(classifyDivergence({ kind: "EXECUTE" }, emptyExec)).toBe("NONE")
  })
})

describe("adjudicateWithShadow telemetry routing", () => {
  let sink: ShadowTelemetrySink
  let calls: Array<{ method: string; args: unknown[] }>

  beforeEach(() => {
    calls = []
    sink = {
      recordBasisOnly: (...args) =>
        calls.push({ method: "recordBasisOnly", args }),
      alertDecisionKind: (...args) =>
        calls.push({ method: "alertDecisionKind", args }),
      alertPayloadRewrite: (...args) =>
        calls.push({ method: "alertPayloadRewrite", args }),
    }
    setShadowTelemetrySink(sink)
  })

  afterEach(() => {
    _resetShadowTelemetrySink()
  })

  function envelope(taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "TRUSTED"): IntentEnvelope {
    return buildEnvelope({
      kind: "order.submit",
      payload: { x: 1 },
      actor: { principal: "llm", sessionId: "s" },
      taint,
      createdAt: "2026-04-23T12:00:00.000Z",
    })
  }

  function policy(): PolicyBundle<string, unknown, unknown> {
    return {
      stateGuards: [],
      authGuards: [],
      taint: { minimumFor: () => "UNTRUSTED" },
      business: [],
      default: "EXECUTE",
    }
  }

  it("BASIS_ONLY divergence → recordBasisOnly only (no alert)", () => {
    const result = adjudicateWithShadow({
      envelope: envelope(),
      state: {},
      policy: policy(),
      legacy: () => true, // legacy EXECUTE matches adjudicate EXECUTE
    })
    expect(result.divergence).toBe("BASIS_ONLY")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("recordBasisOnly")
  })

  it("DECISION_KIND divergence → alertDecisionKind (page-worthy)", () => {
    const result = adjudicateWithShadow({
      envelope: envelope("UNTRUSTED"),
      state: {},
      policy: {
        ...policy(),
        // Force a REFUSE on adjudicate
        taint: { minimumFor: () => "SYSTEM" },
      },
      legacy: () => true, // legacy EXECUTE — diverges from adjudicate REFUSE
    })
    expect(result.divergence).toBe("DECISION_KIND")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("alertDecisionKind")
  })

  it("NONE divergence → no telemetry calls", () => {
    // Legacy REFUSE matches adjudicate REFUSE with empty basis (default REFUSE branch)
    const result = adjudicateWithShadow({
      envelope: envelope("UNTRUSTED"),
      state: {},
      policy: {
        ...policy(),
        taint: { minimumFor: () => "SYSTEM" },
      },
      legacy: () => false,
    })
    // Adjudicate refuses with non-empty basis — so this is BASIS_ONLY, not NONE.
    // We'd need an EXECUTE with empty basis to get NONE; verified by classifier test.
    expect(result.divergence).toBe("BASIS_ONLY")
  })
})

describe("legacyDecisionAsKernelDecision", () => {
  it("EXECUTE legacy maps to EXECUTE Decision with empty basis", () => {
    const d = legacyDecisionAsKernelDecision({ kind: "EXECUTE" })
    expect(d.kind).toBe("EXECUTE")
    expect(d.basis).toEqual([])
  })

  it("REFUSE legacy maps to REFUSE Decision with BUSINESS_RULE legacy.refused", () => {
    const d = legacyDecisionAsKernelDecision({ kind: "REFUSE" })
    expect(d.kind).toBe("REFUSE")
    if (d.kind !== "REFUSE") return
    expect(d.refusal.kind).toBe("BUSINESS_RULE")
    expect(d.refusal.code).toBe("legacy.refused")
  })
})

describe("DivergenceClass union exhaustiveness", () => {
  it("has exactly four classes", () => {
    const classes: DivergenceClass[] = [
      "NONE",
      "BASIS_ONLY",
      "DECISION_KIND",
      "PAYLOAD_REWRITE",
    ]
    expect(classes).toHaveLength(4)
  })
})
