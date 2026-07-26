// extraction/__tests__/eval-score.test.ts — LE2-05: TDD for the offline
// scorer's PURE core (structural comparison, the refusal category, the
// no-artifact path). No model, no server, no database — scripted fixtures
// only, exactly as `accuracy.test.ts` does for the live meter's core.

import { describe, expect, it } from "vitest"
import { EVAL_REFUSAL_CAPABILITY } from "../eval-schema.js"
import {
  computeClassification,
  computeRefusalCategory,
  computeUnscoreableSummary,
  envelopeFromAuditGold,
  envelopeFromWire,
  normalizeStructuralValue,
  normalizeUtterance,
  parseWireCompletion,
  scoreEvalCase,
  structuralEquals,
  unscoreableReason,
  type EvalParseCase,
  type EvalRefusalCase,
  type ParsedEnvelope,
} from "../eval-score.js"
import type { ExpectPayload } from "../schema.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseCase(overrides: Partial<EvalParseCase> & { expectPayload: ExpectPayload }): EvalParseCase {
  return {
    kind: "parse",
    capability: "order.status.transition",
    caseId: "a",
    utterance: "marca o pedido como pronto",
    ...overrides,
  }
}

function refusalCase(overrides: Partial<EvalRefusalCase> = {}): EvalRefusalCase {
  return {
    kind: "refusal",
    capability: EVAL_REFUSAL_CAPABILITY,
    caseId: "greeting",
    utterance: "Oi",
    ...overrides,
  }
}

function envelope(overrides: Partial<ParsedEnvelope> = {}): ParsedEnvelope {
  return {
    capability: "order.status.transition",
    extractionIR: { payload: { newStatus: "ready" } },
    source: "audit-gold",
    fixtureId: "fx",
    ...overrides,
  }
}

// ── Normalization / structural comparison ───────────────────────────────────

describe("normalizeUtterance (the case↔artifact join key)", () => {
  it("folds case, NFC form, outer padding and inner whitespace runs", () => {
    expect(normalizeUtterance("  Marca   o PEDIDO\ncomo Pronto ")).toBe("marca o pedido como pronto")
  })

  it("treats decomposed and composed accents as the same utterance", () => {
    expect(normalizeUtterance("Você".normalize("NFD"))).toBe(normalizeUtterance("Você"))
  })
})

describe("structuralEquals (formatting noise tolerated, wrong values not)", () => {
  it("tolerates casing / padding / collapsed whitespace on string slots", () => {
    expect(structuralEquals("  READY ", "ready")).toBe(true)
    expect(structuralEquals("Coca  Cola", "coca cola")).toBe(true)
  })

  it("compares arrays and objects BY VALUE (the default comparator cannot)", () => {
    expect(structuralEquals([], [])).toBe(true)
    expect(structuralEquals({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true)
    expect(structuralEquals(["a", "b"], ["b", "a"])).toBe(false)
  })

  it("does NOT coerce types — a numeric string is a WRONG SLOT, not formatting noise", () => {
    expect(structuralEquals("2", 2)).toBe(false)
    expect(structuralEquals("true", true)).toBe(false)
  })

  it("rejects a genuinely different value", () => {
    expect(structuralEquals("ready", "preparing")).toBe(false)
  })

  it("normalizeStructuralValue recurses into nested structures", () => {
    expect(normalizeStructuralValue({ a: [" X ", { b: "Y  Z" }] })).toEqual({
      a: ["x", { b: "y z" }],
    })
  })
})

// ── Wire completion reading ─────────────────────────────────────────────────

describe("parseWireCompletion (deliberately non-salvaging — LE2-02 owns salvage)", () => {
  it("reads a bare capability envelope", () => {
    expect(parseWireCompletion('{"capability": "order.note.add", "payload": {"body": "Oi"}}')).toEqual({
      capability: "order.note.add",
      payload: { body: "Oi" },
    })
  })

  it("reads an explicit null capability as NO parse", () => {
    expect(parseWireCompletion('{ "capability": null, "payload": null }')).toEqual({
      capability: null,
      payload: {},
    })
  })

  it("unwraps a single ```json fence", () => {
    expect(parseWireCompletion('```json\n{"capability":"order.cancel","payload":{}}\n```')).toEqual({
      capability: "order.cancel",
      payload: {},
    })
  })

  it("reads a JSON object with no capability key as NO parse", () => {
    expect(parseWireCompletion('{"text":"Sim, entregamos em Ibate."}')).toEqual({
      capability: null,
      payload: {},
    })
  })

  it("NEVER salvages capability JSON stranded inside prose (that is LE2-02's before/after delta)", () => {
    expect(
      parseWireCompletion('Claro! {"capability":"order.cancel","payload":{}} pronto.'),
    ).toEqual({ capability: null, payload: {} })
  })

  it("reads prose and malformed JSON as NO parse rather than throwing", () => {
    expect(parseWireCompletion("E aí! Tudo bem?")).toEqual({ capability: null, payload: {} })
    expect(parseWireCompletion("{not json")).toEqual({ capability: null, payload: {} })
  })
})

describe("envelopeFromWire", () => {
  it("prefers an express_intent tool call over the text completion", () => {
    const result = envelopeFromWire(
      {
        utterance: "cancela",
        completion: "bla bla",
        toolCall: { name: "express_intent", arguments: { capability: "order.cancel", payload: { reason: "x" } } },
      },
      "fx",
    )
    expect(result.capability).toBe("order.cancel")
    expect(result.extractionIR?.payload).toEqual({ reason: "x" })
  })

  it("ignores a READ tool call — a read tool proposes no capability", () => {
    const result = envelopeFromWire(
      { utterance: "cadê meu pedido", toolCall: { name: "check_order_status", arguments: {} } },
      "fx",
    )
    expect(result.capability).toBeNull()
  })

  it("carries extractionIR ONLY — a wire attempt precedes every resolver", () => {
    const result = envelopeFromWire(
      { utterance: "x", completion: '{"capability":"order.cancel","payload":{}}' },
      "fx",
    )
    expect(result.hydratedIntentIR).toBeUndefined()
    expect(result.decision).toBeUndefined()
  })
})

describe("envelopeFromAuditGold", () => {
  it("carries the full sidecar plus the kernel decision", () => {
    const result = envelopeFromAuditGold(
      {
        utterance: "x",
        capability: "order.cancel",
        extractionIR: { payload: {}, provenance: {} },
        hydratedIntentIR: { payload: { orderId: "o1" }, confirmationRequired: true },
        decision: "REQUEST_CONFIRMATION",
      },
      "fx",
    )
    expect(result).toMatchObject({
      capability: "order.cancel",
      decision: "REQUEST_CONFIRMATION",
      source: "audit-gold",
      fixtureId: "fx",
    })
    expect(result.hydratedIntentIR?.confirmationRequired).toBe(true)
  })
})

// ── Scoring: parse cases ────────────────────────────────────────────────────

const EXPECT_READY: ExpectPayload = { extractionIR: { payload: { newStatus: "ready" } } }

describe("scoreEvalCase — parse cases", () => {
  it("passes on the right capability and the right slots", () => {
    const outcome = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [envelope()])
    expect(outcome.result.ok).toBe(true)
    expect(outcome.result.failures).toEqual([])
    expect(outcome.result.unscoreable).toBeUndefined()
  })

  it("tolerates formatting noise in a slot value", () => {
    const outcome = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [
      envelope({ extractionIR: { payload: { newStatus: " READY " } } }),
    ])
    expect(outcome.result.ok).toBe(true)
  })

  it("fails on the WRONG capability, and says so", () => {
    const outcome = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [
      envelope({ capability: "order.cancel" }),
    ])
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.failures[0]).toContain('expected "order.status.transition", got "order.cancel"')
  })

  it("fails on a wrong slot VALUE", () => {
    const outcome = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [
      envelope({ extractionIR: { payload: { newStatus: "preparing" } } }),
    ])
    expect(outcome.result.ok).toBe(false)
  })

  it("fails on an EXTRA slot key — payloadExactKeys discipline is preserved", () => {
    const outcome = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [
      envelope({ extractionIR: { payload: { newStatus: "ready", orderId: "o1" } } }),
    ])
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.failures.join(" ")).toContain("payload keys")
  })

  it("counts a parse case whose captured parse selected NO capability as a FAILURE, not unscoreable", () => {
    const outcome = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [
      envelope({ capability: null, extractionIR: undefined }),
    ])
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.unscoreable).toBeUndefined()
    expect(outcome.result.failures[0]).toContain("selected NO capability")
  })

  it("passes only when EVERY captured parse agrees (an unstable parser is a failing parser)", () => {
    const stable = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [envelope(), envelope()])
    expect(stable.result.ok).toBe(true)

    const unstable = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [
      envelope(),
      envelope({ extractionIR: { payload: { newStatus: "preparing" } } }),
    ])
    expect(unstable.result.ok).toBe(false)
    expect(unstable.observations).toHaveLength(2)
  })
})

// ── Scoring: the refusal (∅) class ──────────────────────────────────────────

describe("scoreEvalCase — refusal cases (the sound-abstain mirror)", () => {
  it("passes when the captured parse selected NO capability", () => {
    const outcome = scoreEvalCase(refusalCase(), [
      envelope({ capability: null, extractionIR: undefined }),
    ])
    expect(outcome.result.ok).toBe(true)
    expect(outcome.observations).toEqual([{ expected: null, observed: null }])
  })

  it("fails — and names the capability — when the utterance LEAKED into one", () => {
    const outcome = scoreEvalCase(refusalCase(), [envelope({ capability: "order.note.add" })])
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.failures[0]).toContain('expected a REFUSAL')
    expect(outcome.result.failures[0]).toContain('"order.note.add"')
  })

  it("is scoreable against a WIRE artifact — refusal needs no resolver output", () => {
    const wire = envelopeFromWire({ utterance: "Oi", completion: "E aí! Tudo bem?" }, "fx")
    expect(unscoreableReason(refusalCase(), wire)).toBeNull()
    expect(scoreEvalCase(refusalCase(), [wire]).result.ok).toBe(true)
  })
})

// ── The no-artifact (UNSCOREABLE) path ──────────────────────────────────────

describe("UNSCOREABLE — a first-class outcome, never a silent skip", () => {
  it("marks a case with NO artifact unscoreable: never passing, never failing", () => {
    const outcome = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [])
    expect(outcome.result.unscoreable).toBe(true)
    expect(outcome.result.ok).toBe(false)
    expect(outcome.unscoreable).toBe("no_artifact")
    expect(outcome.observations).toEqual([])
    expect(outcome.result.failures[0]).toContain("no_artifact")
  })

  it("marks a hydration expectation against a WIRE-only artifact unscoreable, never failing", () => {
    const kase = parseCase({
      expectPayload: { extractionIR: { payload: { newStatus: "ready" } }, hydratedIntentIR: { payloadPresent: ["orderId"] } },
    })
    const wire = envelopeFromWire(
      { utterance: "x", completion: '{"capability":"order.status.transition","payload":{"newStatus":"ready"}}' },
      "fx",
    )
    expect(unscoreableReason(kase, wire)).toBe("hydration_not_observed")
    const outcome = scoreEvalCase(kase, [wire])
    expect(outcome.result.unscoreable).toBe(true)
    expect(outcome.unscoreable).toBe("hydration_not_observed")
  })

  it("marks a provenance expectation against a provenance-less artifact unscoreable", () => {
    const kase = parseCase({
      expectPayload: { extractionIR: { payload: { newStatus: "ready" }, provenanceTrust: { newStatus: "untrusted" } } },
    })
    expect(unscoreableReason(kase, envelope())).toBe("provenance_not_observed")
  })

  it("marks a decision expectation against a decision-less artifact unscoreable", () => {
    const kase = parseCase({ expectPayload: { ...EXPECT_READY, decision: "EXECUTE" } })
    expect(unscoreableReason(kase, envelope())).toBe("decision_not_observed")
  })

  it("SCORES the artifacts that can answer even when a weaker one sits beside them", () => {
    const kase = parseCase({
      expectPayload: { extractionIR: { payload: { newStatus: "ready" } }, decision: "EXECUTE" },
    })
    const weak = envelope()
    const strong = envelope({ decision: "EXECUTE" })
    const outcome = scoreEvalCase(kase, [weak, strong])
    expect(outcome.result.unscoreable).toBeUndefined()
    expect(outcome.result.ok).toBe(true)
    expect(outcome.observations).toHaveLength(1)
  })

  it("rolls unscoreable cases up by reason, in the declared reason order", () => {
    const noArtifact = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [])
    const noDecision = scoreEvalCase(
      parseCase({ caseId: "b", expectPayload: { ...EXPECT_READY, decision: "EXECUTE" } }),
      [envelope()],
    )
    expect(computeUnscoreableSummary([noArtifact, noDecision])).toEqual({
      total: 2,
      byReason: [
        { reason: "no_artifact", cases: 1 },
        { reason: "decision_not_observed", cases: 1 },
      ],
    })
  })
})

// ── The refusal category + classification matrix ────────────────────────────

describe("computeRefusalCategory (its own axis — never folded into pass/fail)", () => {
  const leaked = scoreEvalCase(refusalCase({ caseId: "leak" }), [envelope({ capability: "order.note.add" })])
  const refused = scoreEvalCase(refusalCase({ caseId: "clean" }), [
    envelope({ capability: null, extractionIR: undefined }),
  ])
  const parsed = scoreEvalCase(parseCase({ expectPayload: EXPECT_READY }), [envelope()])
  const wronglyRefused = scoreEvalCase(parseCase({ caseId: "b", expectPayload: EXPECT_READY }), [
    envelope({ capability: null, extractionIR: undefined }),
  ])
  const missing = scoreEvalCase(refusalCase({ caseId: "no-evidence" }), [])

  it("counts every quadrant and derives precision/recall", () => {
    const category = computeRefusalCategory([leaked, refused, parsed, wronglyRefused, missing])
    expect(category).toMatchObject({
      cases: 3,
      scored: 2,
      unscoreable: 1,
      correctlyRefused: 1,
      leaked: 1,
      wronglyRefused: 1,
      parsed: 1,
      precision: 0.5,
      recall: 0.5,
      leaksByCapability: [{ capability: "order.note.add", observations: 1 }],
    })
  })

  it("never divides by zero on an empty set", () => {
    expect(computeRefusalCategory([])).toMatchObject({ precision: 0, recall: 0, cases: 0 })
  })

  it("a SLOT failure never moves the refusal numbers (the two axes are independent)", () => {
    const wrongSlot = scoreEvalCase(parseCase({ caseId: "c", expectPayload: EXPECT_READY }), [
      envelope({ extractionIR: { payload: { newStatus: "preparing" } } }),
    ])
    expect(wrongSlot.result.ok).toBe(false)
    const category = computeRefusalCategory([wrongSlot])
    expect(category).toMatchObject({ leaked: 0, wronglyRefused: 0, parsed: 1 })
  })
})

describe("computeClassification (per-capability precision/recall, ∅ class included)", () => {
  it("reports the ∅ class under the reserved refusal key, sorted with the rest", () => {
    const rows = computeClassification([
      { expected: null, observed: null },
      { expected: null, observed: "order.note.add" },
      { expected: "order.cancel", observed: "order.cancel" },
    ])
    expect(rows.map((r) => r.capability)).toEqual([
      EVAL_REFUSAL_CAPABILITY,
      "order.cancel",
      "order.note.add",
    ])
    expect(rows[0]).toMatchObject({
      expected: 2,
      observed: 1,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 1,
      precision: 1,
      recall: 0.5,
    })
    expect(rows[2]).toMatchObject({ truePositives: 0, falsePositives: 1, precision: 0, recall: 0 })
  })

  it("never divides by zero", () => {
    expect(computeClassification([])).toEqual([])
  })
})
