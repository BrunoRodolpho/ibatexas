// extraction/schema.test.ts — the extraction-corpus file schema (FE-T06).

import { describe, expect, it } from "vitest"
import { validateExtractionCorpus } from "../schema.js"

function validFile(overrides: Record<string, unknown> = {}) {
  return {
    capability: "order.status.transition",
    source: "tickets/language-engine/issues/05-first-tracer.md",
    cases: [
      {
        id: "most-recent-order-to-ready",
        utterance: "muda o status do meu último pedido para pronto",
        expectPayload: {
          extractionIR: {
            payload: { newStatus: "ready" },
            provenanceTrust: { newStatus: "untrusted" },
          },
        },
      },
    ],
    ...overrides,
  }
}

describe("validateExtractionCorpus — happy path", () => {
  it("accepts a well-formed file", () => {
    const result = validateExtractionCorpus(validFile())
    expect(result.ok).toBe(true)
  })

  it("accepts a case with a full hydratedIntentIR expectation", () => {
    const result = validateExtractionCorpus(
      validFile({
        cases: [
          {
            id: "most-recent-order-to-ready",
            utterance: "muda o status do meu último pedido para pronto",
            expectPayload: {
              extractionIR: {
                payload: { newStatus: "ready" },
                provenanceTrust: { newStatus: "untrusted" },
              },
              hydratedIntentIR: {
                payload: { newStatus: "ready" },
                payloadPresent: ["orderId"],
                provenanceTrust: { orderId: "grounded", newStatus: "untrusted" },
                confirmationRequired: true,
              },
            },
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })
})

describe("validateExtractionCorpus — named error codes", () => {
  it("invalid_capability: not dotted-lowercase", () => {
    const result = validateExtractionCorpus(validFile({ capability: "OrderStatusTransition" }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.code)).toContain("invalid_capability")
  })

  it("invalid_case_id: not kebab-case", () => {
    const result = validateExtractionCorpus(
      validFile({
        cases: [
          {
            id: "Most_Recent_Order",
            utterance: "x",
            expectPayload: { extractionIR: { payload: { newStatus: "ready" } } },
          },
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.code)).toContain("invalid_case_id")
  })

  it("duplicate_case_id: two cases share an id", () => {
    const dupCase = {
      id: "same-id",
      utterance: "x",
      expectPayload: { extractionIR: { payload: { newStatus: "ready" } } },
    }
    const result = validateExtractionCorpus(validFile({ cases: [dupCase, dupCase] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.code)).toContain("duplicate_case_id")
  })

  it("schema_violation: an unrecognized top-level key (strict schema)", () => {
    const result = validateExtractionCorpus(validFile({ unknownField: true }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.code)).toContain("schema_violation")
  })

  it("schema_violation: cases must be non-empty", () => {
    const result = validateExtractionCorpus(validFile({ cases: [] }))
    expect(result.ok).toBe(false)
  })

  it("schema_violation: expectPayload.extractionIR is required", () => {
    const result = validateExtractionCorpus(
      validFile({
        cases: [{ id: "x", utterance: "x", expectPayload: {} }],
      }),
    )
    expect(result.ok).toBe(false)
  })
})
