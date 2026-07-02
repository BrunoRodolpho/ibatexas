// IncidentService + incident-policy — unit tests (no live DB).
//
// W1 no-reply incident journal. Covers:
//   - the frozen-cause governance guard (REFUSE off-taxonomy, EXECUTE valid),
//     plus the SYSTEM-only taint floor;
//   - the PURE `deriveSeverity` derivation (plan §6) incl. the re-open bump;
//   - the close contract (current-on-found / current-on-already-closed /
//     null-on-missing — load-bearing for the admin 404);
//   - the open dedup + P2002 race path, against a stubbed prisma.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import { randomUUID } from "node:crypto"

const mockFindFirst = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockUpdateMany = vi.hoisted(() => vi.fn())
const mockFindUnique = vi.hoisted(() => vi.fn())
const mockCount = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    conversationIncident: {
      findFirst: mockFindFirst,
      create: mockCreate,
      update: mockUpdate,
      updateMany: mockUpdateMany,
      findUnique: mockFindUnique,
      count: mockCount,
      findMany: mockFindMany,
    },
  },
}))

vi.mock("../../generated/prisma-client/client.js", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {
      code: string
      meta?: Record<string, unknown>
      clientVersion: string
      constructor(
        message: string,
        opts: { code: string; clientVersion: string; meta?: Record<string, unknown> },
      ) {
        super(message)
        this.code = opts.code
        this.clientVersion = opts.clientVersion
        this.meta = opts.meta
      }
    },
  },
}))

import {
  createIncidentService,
  deriveSeverity,
} from "../incident.service.js"
import { Prisma } from "../../generated/prisma-client/client.js"
import type {
  IncidentOpenPayload,
  IncidentClosePayload,
  IncidentState,
} from "../__shared__/incident-policy.js"

const state: IncidentState = { ctx: {} }

const OPENED_AT = new Date("2026-06-29T12:00:00.000Z")

// Minimal ConversationIncident-shaped row (only the fields the service reads).
function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inc_01",
    sessionId: "wa:5511999999999",
    conversationId: null,
    customerId: null,
    channel: "whatsapp",
    senderRef: null,
    kind: "no_reply",
    cause: "empty_completion",
    lastCause: "empty_completion",
    severity: "medium",
    status: "OPEN",
    dropCount: 1,
    customerImpacted: true,
    openedAt: OPENED_AT,
    lastDropAt: OPENED_AT,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionType: null,
    priorIncidentId: null,
    lastTurnId: null,
    lastDecisionKind: null,
    closingTurnId: null,
    externalId: "whatsapp:wa:5511999999999:turn_1",
    phoneHash: null,
    detail: null,
    createdAt: OPENED_AT,
    updatedAt: OPENED_AT,
    ...over,
  } as never
}

function openPayload(over: Partial<IncidentOpenPayload> = {}): IncidentOpenPayload {
  return {
    sessionId: "wa:5511999999999",
    cause: "empty_completion",
    channel: "whatsapp",
    externalId: "whatsapp:wa:5511999999999:turn_1",
    ...over,
  }
}

const systemOpenEnv = (payload: IncidentOpenPayload) =>
  buildEnvelope({
    kind: "incident.ticket.open" as const,
    payload,
    actor: { principal: "system" as const, sessionId: "conversation.no_delivery:turn_1" },
    taint: "SYSTEM" as const,
    nonce: randomUUID(),
  })

const untrustedOpenEnv = (payload: IncidentOpenPayload) =>
  buildEnvelope({
    kind: "incident.ticket.open" as const,
    payload,
    actor: { principal: "llm" as const, sessionId: "wa:test" },
    taint: "UNTRUSTED" as const,
    nonce: randomUUID(),
  })

const systemCloseEnv = (payload: IncidentClosePayload) =>
  buildEnvelope({
    kind: "incident.ticket.close" as const,
    payload,
    actor: { principal: "system" as const, sessionId: "incident.close:turn_2" },
    taint: "SYSTEM" as const,
    nonce: randomUUID(),
  })

describe("incident-policy — frozen-cause governance guard", () => {
  beforeEach(() => vi.clearAllMocks())

  it("EXECUTEs a valid in-taxonomy cause (executor runs, fresh incident created)", async () => {
    mockFindFirst.mockResolvedValue(null) // no existing open, no prior terminal
    mockCreate.mockResolvedValue(makeRow())

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(
      systemOpenEnv(openPayload({ cause: "send_failed" })),
      state,
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result?.opened).toBe(true)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("REFUSEs an out-of-taxonomy cause (executor never runs)", async () => {
    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(
      systemOpenEnv(
        openPayload({ cause: "bogus_cause" as IncidentOpenPayload["cause"] }),
      ),
      state,
    )

    expect(out.decision.kind).toBe("REFUSE")
    expect(out.result).toBeUndefined()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  it("REFUSEs an UNTRUSTED proposal even with a valid cause (SYSTEM-only)", async () => {
    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(
      untrustedOpenEnv(openPayload()),
      state,
    )

    expect(out.decision.kind).toBe("REFUSE")
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe("deriveSeverity — pure derivation (plan §6)", () => {
  const recent = OPENED_AT
  const now = OPENED_AT // age 0

  it("silêncio + fresh single drop → medium", () => {
    expect(
      deriveSeverity({ customerImpacted: true, dropCount: 1, openedAt: recent, now }),
    ).toBe("medium")
  })

  it("silêncio + aged (>20min) → high", () => {
    const aged = new Date(OPENED_AT.getTime() + 21 * 60_000)
    expect(
      deriveSeverity({ customerImpacted: true, dropCount: 1, openedAt: recent, now: aged }),
    ).toBe("high")
  })

  it("silêncio + dropCount≥2 → high", () => {
    expect(
      deriveSeverity({ customerImpacted: true, dropCount: 2, openedAt: recent, now }),
    ).toBe("high")
  })

  it("aviso enviado + recent → low", () => {
    expect(
      deriveSeverity({ customerImpacted: false, dropCount: 1, openedAt: recent, now }),
    ).toBe("low")
  })

  it("aviso enviado + aged → medium (not low, not high)", () => {
    const aged = new Date(OPENED_AT.getTime() + 21 * 60_000)
    expect(
      deriveSeverity({ customerImpacted: false, dropCount: 1, openedAt: recent, now: aged }),
    ).toBe("medium")
  })

  it("re-open bumps up one band: aviso enviado + recent + reaberto → medium", () => {
    expect(
      deriveSeverity({
        customerImpacted: false,
        dropCount: 1,
        openedAt: recent,
        priorIncidentId: "inc_prior",
        now,
      }),
    ).toBe("medium")
  })

  it("re-open never bumps above high: silêncio + aged + reaberto stays high", () => {
    const aged = new Date(OPENED_AT.getTime() + 21 * 60_000)
    expect(
      deriveSeverity({
        customerImpacted: true,
        dropCount: 3,
        openedAt: recent,
        priorIncidentId: "inc_prior",
        now: aged,
      }),
    ).toBe("high")
  })
})

describe("closeIncidentFromEnvelope — current-on-found / null-on-missing", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the transitioned incident when the id exists and was open", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue(
      makeRow({ status: "RESOLVED", resolvedBy: "staff:1", resolutionType: "STAFF" }),
    )

    const svc = createIncidentService()
    const out = await svc.closeIncidentFromEnvelope(
      systemCloseEnv({ id: "inc_01", resolvedBy: "staff:1", resolutionType: "STAFF" }),
      state,
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result).not.toBeNull()
    expect((out.result as { status: string }).status).toBe("RESOLVED")
  })

  it("returns the current row (no error) when already closed (count===0, idempotent)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue(makeRow({ status: "AUTO_RESOLVED" }))

    const svc = createIncidentService()
    const out = await svc.closeIncidentFromEnvelope(
      systemCloseEnv({ id: "inc_01", resolvedBy: "system", resolutionType: "AUTO" }),
      state,
    )

    expect(out.result).not.toBeNull()
    expect((out.result as { status: string }).status).toBe("AUTO_RESOLVED")
  })

  it("returns null ONLY when the id does not exist", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue(null)

    const svc = createIncidentService()
    const out = await svc.closeIncidentFromEnvelope(
      systemCloseEnv({ id: "missing", resolvedBy: "system", resolutionType: "AUTO" }),
      state,
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result).toBeNull()
  })

  it("AUTO resolution transitions to AUTO_RESOLVED (status derived from resolutionType)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue(makeRow({ status: "AUTO_RESOLVED" }))

    const svc = createIncidentService()
    await svc.closeIncidentFromEnvelope(
      systemCloseEnv({ id: "inc_01", resolvedBy: "system", resolutionType: "AUTO" }),
      state,
    )

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AUTO_RESOLVED" }),
      }),
    )
  })
})

describe("openIncidentFromEnvelope — dedup + P2002 race", () => {
  // resetAllMocks (not clearAllMocks) so that mockFindUnique's implementation is
  // wiped between tests — the new externalId short-circuit in openExecutor calls
  // findUnique unconditionally, so stale mockResolvedValue from the close-block
  // tests would otherwise fire the guard when it should be a no-op.
  beforeEach(() => vi.resetAllMocks())

  it("increments an existing non-terminal incident (no new row)", async () => {
    mockFindFirst.mockResolvedValueOnce(makeRow({ dropCount: 1 })) // existing open
    mockUpdate.mockResolvedValue(makeRow({ dropCount: 2 }))

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(systemOpenEnv(openPayload()), state)

    expect(out.result?.opened).toBe(false)
    expect((out.result?.incident as { dropCount: number }).dropCount).toBe(2)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("links priorIncidentId from the newest terminal row on a re-open", async () => {
    mockFindFirst
      .mockResolvedValueOnce(null) // no existing open
      .mockResolvedValueOnce({ id: "inc_prior" }) // newest terminal row
    mockCreate.mockResolvedValue(makeRow({ priorIncidentId: "inc_prior" }))

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(systemOpenEnv(openPayload()), state)

    expect(out.result?.opened).toBe(true)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priorIncidentId: "inc_prior" }),
      }),
    )
  })

  it("catches a session-unique P2002 → re-reads the open row + increments", async () => {
    mockFindFirst
      .mockResolvedValueOnce(null) // existing check: none
      .mockResolvedValueOnce(null) // prior terminal: none
      .mockResolvedValueOnce(makeRow({ dropCount: 1 })) // racing re-read after P2002
    mockCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "conversation_incidents_session_open_uq" },
      }),
    )
    mockUpdate.mockResolvedValue(makeRow({ dropCount: 2 }))

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(systemOpenEnv(openPayload()), state)

    expect(out.result?.opened).toBe(false)
    expect((out.result?.incident as { dropCount: number }).dropCount).toBe(2)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it("redelivery of the same externalId while incident is OPEN does not increment dropCount", async () => {
    // The row already exists for this externalId (sequential at-least-once redelivery
    // while the incident is still OPEN). The new short-circuit at the top of openExecutor
    // should return it as-is without calling update or create.
    mockFindUnique.mockResolvedValue(makeRow({ dropCount: 1, status: "OPEN" }))

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(systemOpenEnv(openPayload()), state)

    expect(out.result?.opened).toBe(false)
    expect((out.result?.incident as { dropCount: number }).dropCount).toBe(1)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("catches an externalId P2002 → idempotent replay (returns existing, no increment)", async () => {
    // Short-circuit guard sees no row yet (first findUnique call); create races and
    // loses with a P2002 on the externalId unique index; catch block re-reads the
    // row (second findUnique call) and returns it without incrementing.
    mockFindUnique
      .mockResolvedValueOnce(null) // (0) short-circuit: externalId not yet in DB
      .mockResolvedValueOnce(makeRow({ dropCount: 1 })) // (0-catch) re-read after P2002
    mockFindFirst
      .mockResolvedValueOnce(null) // (1) existing open: none
      .mockResolvedValueOnce(null) // (2) prior terminal: none
    mockCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "conversation_incidents_external_id_key" },
      }),
    )

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(systemOpenEnv(openPayload()), state)

    expect(out.result?.opened).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { externalId: "whatsapp:wa:5511999999999:turn_1" },
    })
  })
})

describe("incrementDrop — replay-guard + customerImpacted monotonicity", () => {
  beforeEach(() => vi.resetAllMocks())

  it("[M6] advances externalId to the new drop's id so a redelivered increment replays (no double-count)", async () => {
    mockFindUnique.mockResolvedValue(null) // (0) this drop's externalId not yet persisted
    mockFindFirst.mockResolvedValueOnce(
      makeRow({ dropCount: 1, externalId: "whatsapp:wa:5511999999999:turn_1" }),
    ) // (1) existing OPEN incident, opened by an earlier drop
    mockUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      makeRow({ ...data, dropCount: 2 }),
    )

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(
      systemOpenEnv(openPayload({ externalId: "whatsapp:wa:5511999999999:turn_2" })),
      state,
    )

    expect(out.result?.opened).toBe(false)
    // The row's externalId now points at THIS drop → a redelivery of turn_2 hits
    // the step-0 findUnique guard and returns as-is instead of incrementing again.
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalId: "whatsapp:wa:5511999999999:turn_2",
          dropCount: { increment: 1 },
        }),
      }),
    )
  })

  it("[M8] escalates customerImpacted false→true on a customer-impacting drop (enters the silêncio/high branch)", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockFindFirst.mockResolvedValueOnce(
      makeRow({ dropCount: 1, customerImpacted: false, severity: "low" }),
    ) // degraded incident: a canned message reached the customer (aviso enviado)
    mockUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      makeRow({ ...data, dropCount: 2 }),
    )

    const svc = createIncidentService()
    await svc.openIncidentFromEnvelope(
      systemOpenEnv(openPayload({ customerImpacted: true })), // TRUE-ghost: nothing reached the customer
      state,
    )

    // Persisted TRUE + recomputed severity high (silêncio + dropCount≥2). Pre-fix
    // the update carried no customerImpacted at all, so it stayed degraded.
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerImpacted: true, severity: "high" }),
      }),
    )
  })

  it("[M8] never downgrades customerImpacted true→false on a non-impacting drop", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockFindFirst.mockResolvedValueOnce(
      makeRow({ dropCount: 1, customerImpacted: true }),
    )
    mockUpdate.mockResolvedValue(makeRow({ dropCount: 2 }))

    const svc = createIncidentService()
    await svc.openIncidentFromEnvelope(
      systemOpenEnv(openPayload({ customerImpacted: false })),
      state,
    )

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerImpacted: true }),
      }),
    )
  })
})

describe("list — severity filter matches the DERIVED (read-time) severity [M7]", () => {
  beforeEach(() => vi.resetAllMocks())

  it("includes a row that aged into 'high' even though its persisted severity column lags at 'medium'", async () => {
    const agedOpenedAt = new Date(Date.now() - 21 * 60_000) // past the 20-min aging threshold
    // silêncio + aged → deriveSeverity = high, but the column was frozen at 'medium'
    // (written when the drop was fresh). Filtering on the stale column would drop it.
    const agedSilencio = makeRow({
      id: "aged",
      severity: "medium",
      customerImpacted: true,
      dropCount: 1,
      openedAt: agedOpenedAt,
    })
    // aviso enviado + fresh → derives to 'low'.
    const freshAviso = makeRow({
      id: "fresh",
      severity: "low",
      customerImpacted: false,
      dropCount: 1,
      openedAt: new Date(),
    })
    mockFindMany.mockResolvedValue([agedSilencio, freshAviso])
    mockCount.mockResolvedValue(2)

    const svc = createIncidentService()
    const out = await svc.list({ severity: "high" })

    // Only the aged row matches the DERIVED severity — the displayed set and the
    // filtered set agree.
    expect(out.rows).toHaveLength(1)
    expect((out.rows[0] as { id: string }).id).toBe("aged")
    expect(out.rows[0]!.severity).toBe("high")

    // The severity predicate is NOT pushed into the DB where-clause of the LIST
    // query (it can't be — the column is stale). The list query is the findMany
    // WITHOUT a resolvedAt bound (that one is the independent stats aggregate).
    const listCall = mockFindMany.mock.calls.find(
      (c) => !(c[0] as { where: Record<string, unknown> }).where.resolvedAt,
    )!
    const whereArg = (listCall[0] as { where: Record<string, unknown> }).where
    expect(whereArg).not.toHaveProperty("severity")

    // Independent open count is preserved (never rows.length).
    expect(out.openCount).toBe(2)
  })
})

describe("list — openCount NON_TERMINAL (M11) + independent stats aggregate (M10)", () => {
  beforeEach(() => vi.resetAllMocks())

  // count(...) keyed by the queried status so we can distinguish the three count
  // calls (NON_TERMINAL openCount, OPEN stat, ACKNOWLEDGED stat) regardless of order.
  function keyCounts(openN: number, ackN: number) {
    mockCount.mockImplementation((args: { where: { status: unknown } }) => {
      const s = args.where.status
      if (s === "OPEN") return Promise.resolve(openN)
      if (s === "ACKNOWLEDGED") return Promise.resolve(ackN)
      return Promise.resolve(openN + ackN) // NON_TERMINAL { in: [...] }
    })
  }
  // findMany routes the resolved-since aggregate (has a resolvedAt bound) vs the
  // list-window query (no resolvedAt bound) to distinct fixtures.
  function keyFindMany(resolvedRows: unknown[], listRows: unknown[]) {
    mockFindMany.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.resolvedAt ? resolvedRows : listRows),
    )
  }

  it("[M11] openCount counts NON_TERMINAL — an ACKNOWLEDGED incident is included, not dropped", async () => {
    keyCounts(3, 2) // 3 OPEN + 2 ACKNOWLEDGED
    keyFindMany([], [makeRow({ id: "o1", status: "OPEN" })])

    const svc = createIncidentService()
    const out = await svc.list()

    // Pre-M11 openCount was OPEN-only (3); the badge must now be OPEN+ACK = 5.
    expect(out.openCount).toBe(5)
    // The badge query used the NON_TERMINAL { in: [...] } predicate (not status:"OPEN").
    const nonTerminalCall = mockCount.mock.calls.find(
      (c) => typeof (c[0] as { where: { status: unknown } }).where.status === "object",
    )!
    expect(
      (nonTerminalCall[0] as { where: { status: { in: string[] } } }).where.status.in,
    ).toEqual(expect.arrayContaining(["OPEN", "ACKNOWLEDGED"]))
  })

  it("[M10] stats come from an INDEPENDENT resolved-since set, not the OPEN-first list window", async () => {
    const resolvedAuto = makeRow({
      id: "r_auto",
      status: "AUTO_RESOLVED",
      resolutionType: "AUTO",
      openedAt: new Date("2026-06-29T10:00:00.000Z"),
      resolvedAt: new Date("2026-06-29T10:10:00.000Z"), // 10 min
    })
    const resolvedStaff = makeRow({
      id: "r_staff",
      status: "RESOLVED",
      resolutionType: "STAFF",
      openedAt: new Date("2026-06-29T10:00:00.000Z"),
      resolvedAt: new Date("2026-06-29T10:30:00.000Z"), // 30 min
    })
    // HANDED_OFF is a SYSTEM-driven close (resolveIncidentOnHandoff → system:escalation),
    // NOT staff work: it must count toward `resolvedAuto`, not `resolvedStaff` (F4).
    const resolvedHandoff = makeRow({
      id: "r_handoff",
      status: "RESOLVED",
      resolvedBy: "system:escalation",
      resolutionType: "HANDED_OFF",
      openedAt: new Date("2026-06-29T10:00:00.000Z"),
      resolvedAt: new Date("2026-06-29T10:20:00.000Z"), // 20 min
    })
    // Storm: the list window (limit=100) holds ONLY open rows — zero resolved —
    // yet the stats aggregate is computed from its own resolved-since query.
    const stormWindow = Array.from({ length: 100 }, (_, i) =>
      makeRow({ id: `open_${i}`, status: "OPEN" }),
    )
    keyCounts(100, 4)
    keyFindMany([resolvedAuto, resolvedStaff, resolvedHandoff], stormWindow)

    const svc = createIncidentService()
    const out = await svc.list({ limit: 100 })

    // resolved-today reflects the independent set although the window has none.
    // (stats is present on the first page — the default; optional-chained now that
    // `list()` may skip the aggregate while paginating.)
    expect(out.stats?.resolvedToday).toBe(3)
    // AUTO + HANDED_OFF are system-driven → resolvedAuto=2; only STAFF is "você".
    expect(out.stats?.resolvedAuto).toBe(2)
    expect(out.stats?.resolvedStaff).toBe(1)
    expect(out.stats?.avgMinutes).toBe(20) // mean(10, 30, 20) minutes
    // open is OPEN-only (NOT the NON_TERMINAL openCount); acknowledged is ACK-only.
    expect(out.stats?.open).toBe(100)
    expect(out.stats?.acknowledged).toBe(4)
    expect(out.openCount).toBe(104) // badge = NON_TERMINAL (100 + 4)

    // The resolved-since query filtered on TERMINAL status + a resolvedAt lower bound.
    const resolvedCall = mockFindMany.mock.calls.find(
      (c) => (c[0] as { where: Record<string, unknown> }).where.resolvedAt,
    )!
    const w = (resolvedCall[0] as {
      where: { status: { in: string[] }; resolvedAt: { gte: Date } }
    }).where
    expect(w.status.in).toEqual(expect.arrayContaining(["AUTO_RESOLVED", "RESOLVED"]))
    expect(w.resolvedAt.gte).toBeInstanceOf(Date)
  })

  it("[M10] ignores negative durations and returns 0 avgMinutes when the set is empty", async () => {
    const skewed = makeRow({
      id: "skewed",
      status: "RESOLVED",
      resolutionType: "STAFF",
      openedAt: new Date("2026-06-29T10:10:00.000Z"),
      resolvedAt: new Date("2026-06-29T10:00:00.000Z"), // resolved BEFORE opened (skew)
    })
    keyCounts(0, 0)
    keyFindMany([skewed], [])

    const svc = createIncidentService()
    const out = await svc.list()

    expect(out.stats?.resolvedToday).toBe(1) // still counted
    expect(out.stats?.avgMinutes).toBe(0) // negative duration ignored → no data → 0
  })

  it("[M10] defaults resolvedSince to server start-of-today and honors an explicit value", async () => {
    keyCounts(0, 0)
    keyFindMany([], [])
    const svc = createIncidentService()

    await svc.list()
    const defCall = mockFindMany.mock.calls.find(
      (c) => (c[0] as { where: Record<string, unknown> }).where.resolvedAt,
    )!
    const defGte = (defCall[0] as { where: { resolvedAt: { gte: Date } } }).where
      .resolvedAt.gte
    // Start-of-(server-local)-today: all sub-day components zeroed.
    expect([
      defGte.getHours(),
      defGte.getMinutes(),
      defGte.getSeconds(),
      defGte.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0])

    mockFindMany.mockClear()
    const since = new Date("2026-06-01T00:00:00.000Z")
    await svc.list({ resolvedSince: since })
    const expCall = mockFindMany.mock.calls.find(
      (c) => (c[0] as { where: Record<string, unknown> }).where.resolvedAt,
    )!
    expect(
      (expCall[0] as { where: { resolvedAt: { gte: Date } } }).where.resolvedAt.gte,
    ).toBe(since)
  })

  // ── Conditional stats aggregate (perf): compute on page 0, skip while paging ──

  const resolvedFixture = () =>
    makeRow({
      id: "r_staff",
      status: "RESOLVED",
      resolutionType: "STAFF",
      openedAt: new Date("2026-06-29T10:00:00.000Z"),
      resolvedAt: new Date("2026-06-29T10:10:00.000Z"),
    })

  it("[perf] SKIPS the M10 stats aggregate when paginating (offset > 0) — stats undefined, no stat queries", async () => {
    keyCounts(3, 2)
    keyFindMany([resolvedFixture()], [makeRow({ id: "o1", status: "OPEN" })])

    const svc = createIncidentService()
    const out = await svc.list({ offset: 20 })

    // No stats on a paginated page; the NON_TERMINAL badge count is still computed.
    expect(out.stats).toBeUndefined()
    expect(out.openCount).toBe(5)
    // The expensive resolved-since findMany (the stats query) never ran.
    expect(
      mockFindMany.mock.calls.find(
        (c) => (c[0] as { where: Record<string, unknown> }).where.resolvedAt,
      ),
    ).toBeUndefined()
    // Only the NON_TERMINAL openCount ran — no OPEN/ACK string-status stat counts.
    expect(
      mockCount.mock.calls.filter(
        (c) => typeof (c[0] as { where: { status: unknown } }).where.status === "string",
      ),
    ).toHaveLength(0)
  })

  it("[perf] COMPUTES stats on the first page (offset 0) by default", async () => {
    keyCounts(1, 0)
    keyFindMany([resolvedFixture()], [])

    const svc = createIncidentService()
    const out = await svc.list({ offset: 0 })

    expect(out.stats?.resolvedToday).toBe(1)
  })

  it("includeStats:false force-skips even on the first page", async () => {
    keyCounts(1, 0)
    keyFindMany([resolvedFixture()], [])

    const svc = createIncidentService()
    const out = await svc.list({ includeStats: false })

    expect(out.stats).toBeUndefined()
  })

  it("includeStats:true force-computes even while paginating (offset > 0)", async () => {
    keyCounts(1, 1)
    keyFindMany([resolvedFixture()], [])

    const svc = createIncidentService()
    const out = await svc.list({ offset: 40, includeStats: true })

    expect(out.stats?.resolvedToday).toBe(1)
  })
})
