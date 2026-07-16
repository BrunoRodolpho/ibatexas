// extraction/expect-payload.test.ts — compiling a declarative `ExpectPayload`
// into the SAME `PayloadPredicate` the oracle's `where` clause consumes
// (FE-T06, FE-2.2). Proves the compiled predicate through the REAL
// `matchTrajectory` (not a reimplementation) against hand-built
// `AuditRecord` fixtures matching the FE-T05 documented contract shape
// (`record.metadata.languageEngine.{extractionIR,hydratedIntentIR}` —
// apps/api/src/claustrum/language-engine/audit-metadata.ts, never imported
// here — TEST-PLANE ONLY, check-bypass leg 6/7).

import { describe, expect, it } from "vitest"
import type { AuditRecord } from "@adjudicate/core"
import { matchTrajectory } from "../../oracle/audit-trail-matcher.js"
import { compileExpectPayload, evaluateExpectPayload } from "../expect-payload.js"
import type { ExpectPayload } from "../schema.js"

/** A fixture AuditRecord carrying a `languageEngine` metadata sidecar shaped
 *  exactly like `buildLanguageEngineAuditMetadata`'s documented output. */
function fixtureRecord(opts: {
  kind: string
  decision?: AuditRecord["decision"]["kind"]
  metadata?: Record<string, unknown>
  intentHashSuffix?: string
}): AuditRecord {
  const intentHash = ("f".repeat(63) + (opts.intentHashSuffix ?? "0")).slice(0, 64)
  return {
    version: 5,
    intentHash,
    envelope: {
      kind: opts.kind,
      payload: {},
      actor: { principal: "user", sessionId: "admin:staff_1", role: "OWNER" },
      taint: "UNTRUSTED",
      nonce: "n-1",
      createdAt: "2026-07-16T12:00:00.000Z",
      intentHash,
    } as unknown as AuditRecord["envelope"],
    decision: { kind: opts.decision ?? "REQUEST_CONFIRMATION", prompt: "Confirma?" } as unknown as AuditRecord["decision"],
    decision_basis: [],
    at: "2026-07-16T12:00:00.000Z",
    durationMs: 10,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  }
}

const MATCHING_METADATA = {
  languageEngine: {
    extractionIR: {
      capability: "order.status.transition",
      payload: { newStatus: "ready" },
      provenance: { newStatus: { producer: "model", confidence: "explicit", trust: "untrusted" } },
    },
    hydratedIntentIR: {
      capability: "order.status.transition",
      payload: { orderId: "order_recent", newStatus: "ready" },
      provenance: {
        orderId: { producer: "resolver", confidence: "resolved", trust: "grounded" },
        newStatus: { producer: "model", confidence: "explicit", trust: "untrusted" },
      },
      confirmationRequired: true,
    },
  },
}

const EXPECTED: ExpectPayload = {
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
}

describe("evaluateExpectPayload — per-clause diagnostics", () => {
  it("matches a record whose materialized IR satisfies every declared clause", () => {
    const record = fixtureRecord({ kind: "order.status.transition", metadata: MATCHING_METADATA })
    const outcome = evaluateExpectPayload(EXPECTED, record)
    expect(outcome.ok).toBe(true)
    expect(outcome.failures).toEqual([])
  })

  it("fails on a wrong extracted value, naming the failing clause", () => {
    const record = fixtureRecord({
      kind: "order.status.transition",
      metadata: {
        languageEngine: {
          ...MATCHING_METADATA.languageEngine,
          extractionIR: { ...MATCHING_METADATA.languageEngine.extractionIR, payload: { newStatus: "delivered" } },
        },
      },
    })
    const outcome = evaluateExpectPayload(EXPECTED, record)
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.some((f) => f.includes("extractionIR.payload.newStatus"))).toBe(true)
  })

  it("fails when the model's ExtractionIR carries an extra field (e.g. a leaked orderId) — payloadExactKeys defaults true for extractionIR", () => {
    const record = fixtureRecord({
      kind: "order.status.transition",
      metadata: {
        languageEngine: {
          ...MATCHING_METADATA.languageEngine,
          extractionIR: {
            ...MATCHING_METADATA.languageEngine.extractionIR,
            payload: { newStatus: "ready", orderId: "smuggled" },
          },
        },
      },
    })
    const outcome = evaluateExpectPayload(EXPECTED, record)
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.some((f) => f.includes("extractionIR.payload keys"))).toBe(true)
  })

  it("fails when provenance trust doesn't match (e.g. orderId reported authoritative, not grounded)", () => {
    const record = fixtureRecord({
      kind: "order.status.transition",
      metadata: {
        languageEngine: {
          ...MATCHING_METADATA.languageEngine,
          hydratedIntentIR: {
            ...MATCHING_METADATA.languageEngine.hydratedIntentIR,
            provenance: {
              ...MATCHING_METADATA.languageEngine.hydratedIntentIR.provenance,
              orderId: { producer: "resolver", confidence: "resolved", trust: "authoritative" },
            },
          },
        },
      },
    })
    const outcome = evaluateExpectPayload(EXPECTED, record)
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.some((f) => f.includes("hydratedIntentIR.provenance.orderId.trust"))).toBe(true)
  })

  it("fails when confirmationRequired doesn't match", () => {
    const record = fixtureRecord({
      kind: "order.status.transition",
      metadata: {
        languageEngine: {
          ...MATCHING_METADATA.languageEngine,
          hydratedIntentIR: { ...MATCHING_METADATA.languageEngine.hydratedIntentIR, confirmationRequired: false },
        },
      },
    })
    const outcome = evaluateExpectPayload(EXPECTED, record)
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.some((f) => f.includes("confirmationRequired"))).toBe(true)
  })

  it("fails cleanly when record.metadata.languageEngine is absent entirely (e.g. a different capability)", () => {
    const record = fixtureRecord({ kind: "order.note.add" })
    const outcome = evaluateExpectPayload(EXPECTED, record)
    expect(outcome.ok).toBe(false)
    expect(outcome.failures[0]).toMatch(/languageEngine is absent/)
  })

  it("fails when payloadPresent references a field that's MISSING from the payload entirely (not merely empty)", () => {
    const record = fixtureRecord({
      kind: "order.status.transition",
      metadata: {
        languageEngine: {
          ...MATCHING_METADATA.languageEngine,
          hydratedIntentIR: {
            ...MATCHING_METADATA.languageEngine.hydratedIntentIR,
            payload: { newStatus: "ready" }, // orderId key omitted, not merely empty
          },
        },
      },
    })
    const outcome = evaluateExpectPayload(EXPECTED, record)
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.some((f) => f.includes("hydratedIntentIR.payload.orderId"))).toBe(true)
  })

  it("fails when provenanceTrust references a key ABSENT from the provenance map (not merely a wrong trust value)", () => {
    const record = fixtureRecord({
      kind: "order.status.transition",
      metadata: {
        languageEngine: {
          ...MATCHING_METADATA.languageEngine,
          hydratedIntentIR: {
            ...MATCHING_METADATA.languageEngine.hydratedIntentIR,
            // orderId key omitted from the provenance map entirely — distinct from the
            // "wrong trust value" case above, where the key is present but mismatched.
            provenance: { newStatus: MATCHING_METADATA.languageEngine.hydratedIntentIR.provenance.newStatus },
          },
        },
      },
    })
    const outcome = evaluateExpectPayload(EXPECTED, record)
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.some((f) => f.includes("hydratedIntentIR.provenance.orderId.trust"))).toBe(true)
  })
})

describe("compileExpectPayload — wires into the REAL matchTrajectory oracle (FE-2.2)", () => {
  it("a matching record passes an EXACT trajectory match via the compiled where predicate", () => {
    const records = [fixtureRecord({ kind: "order.status.transition", metadata: MATCHING_METADATA })]
    const result = matchTrajectory(
      records,
      [{ intentKind: "order.status.transition", decision: "REQUEST_CONFIRMATION", where: compileExpectPayload(EXPECTED) }],
      { mode: "EXACT" },
    )
    expect(result.ok).toBe(true)
  })

  it("a mismatching record fails the SAME trajectory match, diagnosed as payload_predicate_failed", () => {
    const records = [
      fixtureRecord({
        kind: "order.status.transition",
        metadata: {
          languageEngine: {
            ...MATCHING_METADATA.languageEngine,
            extractionIR: { ...MATCHING_METADATA.languageEngine.extractionIR, payload: { newStatus: "canceled" } },
          },
        },
      }),
    ]
    const result = matchTrajectory(
      records,
      [{ intentKind: "order.status.transition", decision: "REQUEST_CONFIRMATION", where: compileExpectPayload(EXPECTED) }],
      { mode: "EXACT" },
    )
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]?.reason).toBe("payload_predicate_failed")
  })
})
