// extraction/accuracy-runner.test.ts — the drive/settle/dedup logic (FE-T07),
// exercised with a SCRIPTED fetch + a FAKE AuditReader (no live model, no
// HTTP, no DB) — the actual live-model half is proven by the recorded live
// run in the PR report, not by these tests. What IS unit-testable and
// load-bearing here: never throwing on a per-case failure (HTTP error /
// settle timeout), and never re-matching an already-seen intentHash across
// cases sharing one capability + one staff session.

import { describe, expect, it, vi } from "vitest"
import type { AuditRecord } from "@adjudicate/core"
import type { ExtractionCorpusFile } from "../schema.js"
import type { AuditReader, RunSessionScope, FetchAuditRecordsOptions } from "../../oracle/audit-reader.js"
import { driveExtractionCorpusOverOpsChat } from "../accuracy-runner.js"

function fakeRecord(intentHashSuffix: string, capability: string, newStatus: string): AuditRecord {
  const intentHash = ("a".repeat(63) + intentHashSuffix).slice(0, 64)
  return {
    version: 5,
    intentHash,
    envelope: {
      kind: capability,
      payload: {},
      actor: { principal: "user", sessionId: "admin:staff_1", role: "OWNER" },
      taint: "UNTRUSTED",
      nonce: `n-${intentHashSuffix}`,
      createdAt: "2026-07-16T12:00:00.000Z",
      intentHash,
    } as unknown as AuditRecord["envelope"],
    decision: { kind: "REQUEST_CONFIRMATION", prompt: "Confirma?" } as unknown as AuditRecord["decision"],
    decision_basis: [],
    at: "2026-07-16T12:00:00.000Z",
    durationMs: 10,
    metadata: {
      languageEngine: {
        extractionIR: {
          capability,
          payload: { newStatus },
          provenance: { newStatus: { producer: "model", confidence: "explicit", trust: "untrusted" } },
        },
        hydratedIntentIR: {
          capability,
          payload: { orderId: "order_1", newStatus },
          provenance: {
            orderId: { producer: "resolver", confidence: "resolved", trust: "grounded" },
            newStatus: { producer: "model", confidence: "explicit", trust: "untrusted" },
          },
          confirmationRequired: true,
        },
      },
    },
  }
}

function makeExpectPayload(newStatus: string) {
  return {
    extractionIR: { payload: { newStatus }, provenanceTrust: { newStatus: "untrusted" as const } },
    hydratedIntentIR: {
      payload: { newStatus },
      payloadPresent: ["orderId"],
      provenanceTrust: { orderId: "grounded" as const, newStatus: "untrusted" as const },
      confirmationRequired: true,
    },
  }
}

function corpusOf(cases: Array<{ id: string; utterance: string; newStatus: string }>): ExtractionCorpusFile {
  return {
    capability: "order.status.transition",
    source: "test-fixture",
    cases: cases.map((c) => ({
      id: c.id,
      utterance: c.utterance,
      expectPayload: makeExpectPayload(c.newStatus),
    })),
  }
}

/** A minimal AuditReader double: `records` is mutated by the test to simulate settle-latency. */
function fakeAuditReader(getRecords: () => AuditRecord[]): AuditReader {
  return {
    fetchRecords: async (_scope: RunSessionScope, _opts?: FetchAuditRecordsOptions) => getRecords(),
    close: async () => undefined,
  }
}

const SCOPE: RunSessionScope = { sessionIds: ["hashed:aaaaaaaa"] }

describe("driveExtractionCorpusOverOpsChat — happy path", () => {
  it("drives each case, matches its NEW settled record, and scores it via the real evaluateExpectPayload", async () => {
    const corpus = corpusOf([
      { id: "case-a", utterance: "muda para pronto", newStatus: "ready" },
      { id: "case-b", utterance: "confirma o pedido", newStatus: "confirmed" },
    ])
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call += 1
      return new Response(JSON.stringify({ reply: "ok", decision: "REQUEST_CONFIRMATION" }), { status: 200 })
    }) as unknown as typeof fetch

    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)

    const results = await driveExtractionCorpusOverOpsChat([corpus], {
      apiBaseUrl: "http://fake",
      staffCookie: "staff_token=abc",
      staffId: "staff_1",
      audit,
      scope: SCOPE,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        // Append the NEXT scripted record right before the runner's first
        // poll sees it — simulates the sink settling after the POST.
        const res = await (fetchImpl as unknown as typeof fetch)(...args)
        records.push(fakeRecord(String(records.length), "order.status.transition", call === 1 ? "ready" : "confirmed"))
        return res
      }) as typeof fetch,
      settleTimeoutMs: 2000,
      settlePollMs: 10,
      interCaseDelayMs: 0,
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ capability: "order.status.transition", caseId: "case-a", ok: true })
    expect(results[1]).toMatchObject({ capability: "order.status.transition", caseId: "case-b", ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("never re-matches an already-seen intentHash across cases sharing one capability + one staff session", async () => {
    const corpus = corpusOf([
      { id: "case-a", utterance: "muda para pronto", newStatus: "ready" },
      { id: "case-b", utterance: "confirma o pedido", newStatus: "confirmed" },
    ])
    const firstRecord = fakeRecord("1", "order.status.transition", "ready")
    // The oracle returns BOTH records (already-seen + new) from the second
    // poll onward — the runner must pick the truly-new one, not re-match
    // case-a's record for case-b.
    let secondRecordAppeared = false
    const audit = fakeAuditReader(() => {
      const rows = [firstRecord]
      if (secondRecordAppeared) rows.push(fakeRecord("2", "order.status.transition", "confirmed"))
      return rows
    })
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 2) secondRecordAppeared = true
      return new Response(JSON.stringify({ reply: "ok" }), { status: 200 })
    }) as unknown as typeof fetch

    const results = await driveExtractionCorpusOverOpsChat([corpus], {
      apiBaseUrl: "http://fake",
      staffCookie: "staff_token=abc",
      staffId: "staff_1",
      audit,
      scope: SCOPE,
      fetchImpl,
      settleTimeoutMs: 2000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(results[0]?.caseId).toBe("case-a")
    expect(results[1]?.caseId).toBe("case-b")
    // case-b's evaluation must reflect the SECOND (confirmed) record, not a
    // re-match of case-a's (ready) record.
    expect(results[1]?.ok).toBe(true)
  })
})

describe("driveExtractionCorpusOverOpsChat — failure modes never throw", () => {
  it("a non-2xx ops-chat response becomes a failing case result, not a thrown exception", async () => {
    const corpus = corpusOf([{ id: "case-a", utterance: "x", newStatus: "ready" }])
    const audit = fakeAuditReader(() => [])
    const fetchImpl = (async () => new Response("Acesso restrito.", { status: 403 })) as unknown as typeof fetch

    const results = await driveExtractionCorpusOverOpsChat([corpus], {
      apiBaseUrl: "http://fake",
      staffCookie: "staff_token=abc",
      staffId: "staff_1",
      audit,
      scope: SCOPE,
      fetchImpl,
      interCaseDelayMs: 0,
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.failures[0]).toContain("HTTP 403")
  })

  it("a settle timeout (no new audit record ever appears) becomes a failing case result, not a thrown exception or a hang", async () => {
    const corpus = corpusOf([{ id: "case-a", utterance: "x", newStatus: "ready" }])
    const audit = fakeAuditReader(() => []) // never settles
    const fetchImpl = (async () => new Response(JSON.stringify({ reply: "ok" }), { status: 200 })) as unknown as typeof fetch

    const results = await driveExtractionCorpusOverOpsChat([corpus], {
      apiBaseUrl: "http://fake",
      staffCookie: "staff_token=abc",
      staffId: "staff_1",
      audit,
      scope: SCOPE,
      fetchImpl,
      settleTimeoutMs: 50,
      settlePollMs: 10,
      interCaseDelayMs: 0,
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.failures[0]).toContain("no NEW")
  })
})

describe("driveExtractionCorpusOverOpsChat — test isolation", () => {
  it("calls clearHistory before EVERY case (never just the first)", async () => {
    const corpus = corpusOf([
      { id: "case-a", utterance: "x", newStatus: "ready" },
      { id: "case-b", utterance: "y", newStatus: "confirmed" },
    ])
    let n = 0
    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)
    const fetchImpl = (async () => {
      n += 1
      records.push(fakeRecord(String(n), "order.status.transition", n === 1 ? "ready" : "confirmed"))
      return new Response(JSON.stringify({ reply: "ok" }), { status: 200 })
    }) as unknown as typeof fetch
    const clearHistory = vi.fn(async () => undefined)

    await driveExtractionCorpusOverOpsChat([corpus], {
      apiBaseUrl: "http://fake",
      staffCookie: "staff_token=abc",
      staffId: "staff_1",
      audit,
      scope: SCOPE,
      fetchImpl,
      clearHistory,
      settleTimeoutMs: 1000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(clearHistory).toHaveBeenCalledTimes(2)
    expect(clearHistory).toHaveBeenNthCalledWith(1, "staff_1")
    expect(clearHistory).toHaveBeenNthCalledWith(2, "staff_1")
  })
})
