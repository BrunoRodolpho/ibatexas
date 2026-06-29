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
