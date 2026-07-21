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
import {
  driveExtractionCorpusOverOpsChat,
  driveExtractionCorpusOverCustomerChat,
} from "../accuracy-runner.js"

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
    plane: "ops",
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

    const { results } = await driveExtractionCorpusOverOpsChat([corpus], {
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

    const { results } = await driveExtractionCorpusOverOpsChat([corpus], {
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

    const { results } = await driveExtractionCorpusOverOpsChat([corpus], {
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

    const { results } = await driveExtractionCorpusOverOpsChat([corpus], {
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

  it("a clearHistory throw is caught, attributed as an isolationFailure per case, and does NOT abort the run (review MAJOR follow-up, #263 — the case still drives for diagnostic value; the CALLER decides whether the overall report is trustworthy)", async () => {
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
    const clearHistory = vi.fn(async () => {
      throw new Error("REDIS_URL env var required")
    })

    const { results, isolationFailures } = await driveExtractionCorpusOverOpsChat([corpus], {
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

    // NOT swallowed: one isolationFailure per case, never silently dropped.
    expect(isolationFailures).toEqual([
      { capability: "order.status.transition", caseId: "case-a", detail: "REDIS_URL env var required" },
      { capability: "order.status.transition", caseId: "case-b", detail: "REDIS_URL env var required" },
    ])
    // NOT aborted: both cases still drove and scored normally.
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ caseId: "case-a", ok: true })
    expect(results[1]).toMatchObject({ caseId: "case-b", ok: true })
  })
})

// ── FE-T12 — driveExtractionCorpusOverCustomerChat (the customer-plane sibling) ──

/**
 * Session-per-case rotation (team-lead ruling, post-live-calibration
 * review): a deterministic, ENUMERABLE sessionId sequence for tests — each
 * call to the returned factory yields `sess-1`, `sess-2`, ... A fresh
 * instance per `it()` so assertions on per-call ids stay predictable
 * (never a bare `randomUUID`, which the driver defaults to in production).
 */
function testSessionIdFactory(): () => string {
  let n = 0
  return () => {
    n += 1
    return `sess-${n}`
  }
}

/** Mirrors accuracy-cli.ts's real `scopeForSession` shape — derives the scope from the case's rotated sessionId. */
const SCOPE_FOR_SESSION = (sessionId: string): RunSessionScope => ({
  sessionIds: [`hashed:${sessionId}`],
})

function fakeCancelRecord(intentHashSuffix: string, reason: string | undefined): AuditRecord {
  const intentHash = ("b".repeat(63) + intentHashSuffix).slice(0, 64)
  const payload: Record<string, unknown> = reason !== undefined ? { reason } : {}
  return {
    version: 5,
    intentHash,
    envelope: {
      kind: "order.cancel",
      payload: {},
      actor: { principal: "user", sessionId: "sess-1" },
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
          capability: "order.cancel",
          payload,
          provenance:
            reason !== undefined
              ? { reason: { producer: "model", confidence: "explicit", trust: "untrusted" } }
              : {},
        },
        hydratedIntentIR: {
          capability: "order.cancel",
          payload: { ...payload, orderId: "order_1" },
          provenance: {
            orderId: { producer: "resolver", confidence: "resolved", trust: "grounded" },
            ...(reason !== undefined
              ? { reason: { producer: "model", confidence: "explicit", trust: "untrusted" } }
              : {}),
          },
          confirmationRequired: true,
        },
      },
    },
  }
}

function customerCorpusOf(
  cases: Array<{ id: string; utterance: string; reason?: string }>,
): ExtractionCorpusFile {
  return {
    capability: "order.cancel",
    source: "test-fixture",
    plane: "customer",
    cases: cases.map((c) => ({
      id: c.id,
      utterance: c.utterance,
      expectPayload: {
        extractionIR: c.reason !== undefined ? { payload: { reason: c.reason } } : { payload: {} },
        hydratedIntentIR: {
          payloadPresent: ["orderId"],
          provenanceTrust: { orderId: "grounded" as const },
          confirmationRequired: true,
        },
        decision: "REQUEST_CONFIRMATION" as const,
      },
    })),
  }
}

describe("driveExtractionCorpusOverCustomerChat — happy path", () => {
  it("drives each case over POST /api/chat/messages, matches its NEW settled record, and scores it via the real evaluateExpectPayload", async () => {
    const corpus = customerCorpusOf([
      { id: "case-a", utterance: "cancela meu pedido" },
      { id: "case-b", utterance: "cancela, mudei de ideia", reason: "mudei de ideia" },
    ])
    let call = 0
    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)
    const requestUrls: string[] = []

    const { results } = await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        call += 1
        requestUrls.push(String(url))
        JSON.parse(String(init?.body)) // proves the body parses as JSON — never throws here
        records.push(fakeCancelRecord(String(records.length), call === 1 ? undefined : "mudei de ideia"))
        return new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })
      }) as unknown as typeof fetch,
      settleTimeoutMs: 2000,
      settlePollMs: 10,
      interCaseDelayMs: 0,
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ capability: "order.cancel", caseId: "case-a", ok: true })
    expect(results[1]).toMatchObject({ capability: "order.cancel", caseId: "case-b", ok: true })
    expect(requestUrls).toEqual([
      "http://fake/api/chat/messages",
      "http://fake/api/chat/messages",
    ])
  })

  it("never re-matches an already-seen intentHash, even though a fake AuditReader that ignores scope makes both records visible regardless of the (now distinct, rotated) per-case sessionId — the seenIntentHashes dedup stays as defense-in-depth", async () => {
    const corpus = customerCorpusOf([
      { id: "case-a", utterance: "cancela meu pedido" },
      { id: "case-b", utterance: "cancela, mudei de ideia", reason: "mudei de ideia" },
    ])
    const firstRecord = fakeCancelRecord("1", undefined)
    let secondRecordAppeared = false
    const audit = fakeAuditReader(() => {
      const rows = [firstRecord]
      if (secondRecordAppeared) rows.push(fakeCancelRecord("2", "mudei de ideia"))
      return rows
    })
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 2) secondRecordAppeared = true
      return new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })
    }) as unknown as typeof fetch

    const { results } = await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
      fetchImpl,
      settleTimeoutMs: 2000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(results[0]?.caseId).toBe("case-a")
    expect(results[1]?.caseId).toBe("case-b")
    expect(results[1]?.ok).toBe(true)
  })
})

describe("driveExtractionCorpusOverCustomerChat — failure modes never throw", () => {
  it("a non-2xx customer-chat response becomes a failing case result, not a thrown exception", async () => {
    const corpus = customerCorpusOf([{ id: "case-a", utterance: "x" }])
    const audit = fakeAuditReader(() => [])
    const fetchImpl = (async () => new Response("Acesso negado.", { status: 403 })) as unknown as typeof fetch

    const { results } = await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
      fetchImpl,
      interCaseDelayMs: 0,
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.failures[0]).toContain("HTTP 403")
  })

  it("a settle timeout (no new audit record ever appears — e.g. the async fire-and-forget turn never lands) becomes a failing case result, not a thrown exception or a hang", async () => {
    const corpus = customerCorpusOf([{ id: "case-a", utterance: "x" }])
    const audit = fakeAuditReader(() => []) // never settles
    const fetchImpl = (async () => new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })) as unknown as typeof fetch

    const { results } = await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
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

describe("driveExtractionCorpusOverCustomerChat — test isolation (FE-D13)", () => {
  it("calls clearHistory before EVERY case, keyed by EACH case's OWN freshly-rotated sessionId (never a single reused id)", async () => {
    const corpus = customerCorpusOf([
      { id: "case-a", utterance: "x" },
      { id: "case-b", utterance: "y", reason: "mudei de ideia" },
    ])
    let n = 0
    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)
    const fetchImpl = (async () => {
      n += 1
      records.push(fakeCancelRecord(String(n), n === 1 ? undefined : "mudei de ideia"))
      return new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })
    }) as unknown as typeof fetch
    const clearHistory = vi.fn(async () => undefined)

    await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
      fetchImpl,
      clearHistory,
      settleTimeoutMs: 1000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(clearHistory).toHaveBeenCalledTimes(2)
    // Rotated: case-a and case-b get DIFFERENT sessionIds, not one reused id.
    expect(clearHistory).toHaveBeenNthCalledWith(1, "sess-1")
    expect(clearHistory).toHaveBeenNthCalledWith(2, "sess-2")
  })

  it("a clearHistory throw is caught, attributed as an isolationFailure per case, and does NOT abort the run — a lingering park must never silently execute a later case's utterance", async () => {
    const corpus = customerCorpusOf([
      { id: "case-a", utterance: "x" },
      { id: "case-b", utterance: "y", reason: "mudei de ideia" },
    ])
    let n = 0
    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)
    const fetchImpl = (async () => {
      n += 1
      records.push(fakeCancelRecord(String(n), n === 1 ? undefined : "mudei de ideia"))
      return new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })
    }) as unknown as typeof fetch
    const clearHistory = vi.fn(async () => {
      throw new Error("REDIS_URL env var required")
    })

    const { results, isolationFailures } = await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
      fetchImpl,
      clearHistory,
      settleTimeoutMs: 1000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(isolationFailures).toEqual([
      { capability: "order.cancel", caseId: "case-a", detail: "REDIS_URL env var required" },
      { capability: "order.cancel", caseId: "case-b", detail: "REDIS_URL env var required" },
    ])
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ caseId: "case-a", ok: true })
    expect(results[1]).toMatchObject({ caseId: "case-b", ok: true })
  })

  it("derives EACH case's audit scope from that SAME case's rotated sessionId via scopeForSession — never a single static scope", async () => {
    const corpus = customerCorpusOf([
      { id: "case-a", utterance: "x" },
      { id: "case-b", utterance: "y", reason: "mudei de ideia" },
    ])
    let n = 0
    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)
    const fetchImpl = (async () => {
      n += 1
      records.push(fakeCancelRecord(String(n), n === 1 ? undefined : "mudei de ideia"))
      return new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })
    }) as unknown as typeof fetch
    const scopeForSession = vi.fn(SCOPE_FOR_SESSION)

    await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession,
      fetchImpl,
      settleTimeoutMs: 1000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(scopeForSession).toHaveBeenNthCalledWith(1, "sess-1")
    expect(scopeForSession).toHaveBeenNthCalledWith(2, "sess-2")
  })

  it("defaults sessionIdFactory to randomUUID when the caller supplies none — still one fresh id per case, not one static reused id", async () => {
    const corpus = customerCorpusOf([
      { id: "case-a", utterance: "x" },
      { id: "case-b", utterance: "y", reason: "mudei de ideia" },
    ])
    let n = 0
    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)
    const postedSessionIds: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      n += 1
      const body = JSON.parse(String(init?.body)) as { sessionId: string }
      postedSessionIds.push(body.sessionId)
      records.push(fakeCancelRecord(String(n), n === 1 ? undefined : "mudei de ideia"))
      return new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })
    }) as unknown as typeof fetch

    await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
      fetchImpl,
      settleTimeoutMs: 1000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(postedSessionIds).toHaveLength(2)
    expect(postedSessionIds[0]).not.toBe(postedSessionIds[1])
    // A real randomUUID, not a placeholder — sanity-checks the default wiring.
    expect(postedSessionIds[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(postedSessionIds[1]).toMatch(/^[0-9a-f-]{36}$/)
  })
})

// ── beforeCase (cart-seeding integration seam) ───────────────────────────────

describe("driveExtractionCorpusOverCustomerChat — beforeCase (per-case seeding hook)", () => {
  it("calls beforeCase with THIS case's OWN rotated sessionId and the case itself, AFTER clearHistory and BEFORE the POST", async () => {
    const corpus = customerCorpusOf([
      { id: "case-a", utterance: "x" },
      { id: "case-b", utterance: "y", reason: "mudei de ideia" },
    ])
    let n = 0
    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)
    const callOrder: string[] = []
    const clearHistory = vi.fn(async (sessionId: string) => {
      callOrder.push(`clearHistory:${sessionId}`)
    })
    const beforeCase = vi.fn(async (sessionId: string, kase: { id: string }, capability: string) => {
      callOrder.push(`beforeCase:${sessionId}:${kase.id}:${capability}`)
    })
    const fetchImpl = (async () => {
      n += 1
      callOrder.push(`post:${n}`)
      records.push(fakeCancelRecord(String(n), n === 1 ? undefined : "mudei de ideia"))
      return new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })
    }) as unknown as typeof fetch

    await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
      fetchImpl,
      clearHistory,
      beforeCase,
      settleTimeoutMs: 1000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(beforeCase).toHaveBeenCalledTimes(2)
    expect(beforeCase).toHaveBeenNthCalledWith(1, "sess-1", expect.objectContaining({ id: "case-a" }), "order.cancel")
    expect(beforeCase).toHaveBeenNthCalledWith(2, "sess-2", expect.objectContaining({ id: "case-b" }), "order.cancel")
    expect(callOrder).toEqual([
      "clearHistory:sess-1",
      "beforeCase:sess-1:case-a:order.cancel",
      "post:1",
      "clearHistory:sess-2",
      "beforeCase:sess-2:case-b:order.cancel",
      "post:2",
    ])
  })

  it("omitted beforeCase changes nothing — existing callers (order.cancel, no seeding precondition) are unaffected", async () => {
    const corpus = customerCorpusOf([{ id: "case-a", utterance: "x" }])
    const records: AuditRecord[] = []
    const audit = fakeAuditReader(() => records)
    const fetchImpl = (async () => {
      records.push(fakeCancelRecord("1", undefined))
      return new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })
    }) as unknown as typeof fetch

    const { results } = await driveExtractionCorpusOverCustomerChat([corpus], {
      apiBaseUrl: "http://fake",
      customerCookie: "token=abc",
      sessionIdFactory: testSessionIdFactory(),
      audit,
      scopeForSession: SCOPE_FOR_SESSION,
      fetchImpl,
      settleTimeoutMs: 1000,
      settlePollMs: 5,
      interCaseDelayMs: 0,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ caseId: "case-a", ok: true })
  })

  it("a beforeCase throw is NOT caught — it propagates out of the whole drive, unlike a clearHistory failure (a failed seed makes the case meaningless, never folded into a same-shaped case result)", async () => {
    const corpus = customerCorpusOf([{ id: "case-a", utterance: "x" }])
    const audit = fakeAuditReader(() => [])
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 })) as unknown as typeof fetch
    const beforeCase = vi.fn(async () => {
      throw new Error("cart seed failed: no product variants found")
    })

    await expect(
      driveExtractionCorpusOverCustomerChat([corpus], {
        apiBaseUrl: "http://fake",
        customerCookie: "token=abc",
        sessionIdFactory: testSessionIdFactory(),
        audit,
        scopeForSession: SCOPE_FOR_SESSION,
        fetchImpl,
        beforeCase,
        settleTimeoutMs: 1000,
        settlePollMs: 5,
        interCaseDelayMs: 0,
      }),
    ).rejects.toThrow("cart seed failed: no product variants found")
    // Never even POSTed — the seed failure blocks the turn entirely.
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
