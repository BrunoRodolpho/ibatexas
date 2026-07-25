// BKL-211 — the `security_probe` incident journal, at the domain seam.
//
// SCN-106 (prompt injection) / SCN-109 (cross-customer PII probe) already refuse
// correctly; this journal is the AUDIT-TRAIL half. It shares
// `conversation_incidents` with the W1 `no_reply` journal but carries the OPPOSITE
// lifecycle, so the invariants worth pinning are the ones that keep the two apart:
//
//   1. a security open lands on the security journal with the security cause;
//   2. the two journals do NOT fold into each other's per-session open row
//      (the regression the (session_id, kind) index exists to prevent);
//   3. `findOpenBySession` — the lookup behind EVERY delivered-reply close seam —
//      is scoped to `no_reply`, which IS the auto-close exemption;
//   4. the cause⇄kind coupling fails CLOSED at the kernel.

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

import { createIncidentService } from "../incident.service.js"
import {
  NO_REPLY_KIND,
  SECURITY_PROBE_KIND,
  FROZEN_CAUSES,
  INCIDENT_CAUSE_LABELS_PT,
  type IncidentOpenPayload,
  type IncidentState,
} from "../__shared__/incident-policy.js"

const state: IncidentState = { ctx: {} }
const OPENED_AT = new Date("2026-07-25T12:00:00.000Z")
const SESSION = "wa:5511999999999"

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inc_01",
    sessionId: SESSION,
    conversationId: null,
    customerId: null,
    channel: "whatsapp",
    senderRef: null,
    kind: NO_REPLY_KIND,
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
    externalId: "x",
    phoneHash: null,
    detail: null,
    createdAt: OPENED_AT,
    updatedAt: OPENED_AT,
    ...over,
  } as never
}

function securityPayload(over: Partial<IncidentOpenPayload> = {}): IncidentOpenPayload {
  return {
    sessionId: SESSION,
    cause: "security_probe",
    kind: SECURITY_PROBE_KIND,
    channel: "whatsapp",
    externalId: "security.probe_refused:wa:5511999999999:hash_1",
    customerImpacted: false,
    ...over,
  }
}

const systemOpenEnv = (payload: IncidentOpenPayload) =>
  buildEnvelope({
    kind: "incident.ticket.open" as const,
    payload,
    actor: { principal: "system" as const, sessionId: "audit.intent.decision.v1:hash_1" },
    taint: "SYSTEM" as const,
    nonce: randomUUID(),
  })

describe("BKL-211 taxonomy — security_probe is a first-class, labeled cause", () => {
  it("is in the frozen taxonomy (so the kernel guard does not fail it closed)", () => {
    expect(FROZEN_CAUSES).toContain("security_probe")
  })

  it("carries a pt-BR label (Hard Rule 4 — no raw enum key can reach staff)", () => {
    expect(INCIDENT_CAUSE_LABELS_PT.security_probe).toBe(
      "tentativa de acesso indevido (bloqueada)",
    )
  })
})

describe("BKL-211 open — lands on the security journal", () => {
  beforeEach(() => vi.clearAllMocks())

  it("creates a fresh row with kind=security_probe and cause=security_probe", async () => {
    mockFindUnique.mockResolvedValue(null) // no replay
    mockFindFirst.mockResolvedValue(null) // no open, no prior terminal
    mockCreate.mockResolvedValue(
      makeRow({ id: "inc_sec", kind: SECURITY_PROBE_KIND, cause: "security_probe" }),
    )

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(systemOpenEnv(securityPayload()), state)

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result?.opened).toBe(true)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: SECURITY_PROBE_KIND,
          cause: "security_probe",
          // The customer WAS answered (with a refusal) — this is never a ghost.
          customerImpacted: false,
        }),
      }),
    )
  })

  it("scopes the per-session open lookup to the security journal", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockResolvedValue(makeRow({ kind: SECURITY_PROBE_KIND }))

    const svc = createIncidentService()
    await svc.openIncidentFromEnvelope(systemOpenEnv(securityPayload()), state)

    // Every session-scoped read must carry the journal discriminator, else a
    // no_reply row would be found and incremented instead.
    for (const call of mockFindFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ sessionId: SESSION, kind: SECURITY_PROBE_KIND })
    }
  })

  it("an omitted kind defaults to no_reply — every pre-BKL-211 call site is unchanged", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockResolvedValue(makeRow())

    const svc = createIncidentService()
    await svc.openIncidentFromEnvelope(
      systemOpenEnv({
        sessionId: SESSION,
        cause: "empty_completion",
        channel: "whatsapp",
        externalId: "conversation.no_delivery:wa:5511999999999:turn_1",
      }),
      state,
    )

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: NO_REPLY_KIND }) }),
    )
    for (const call of mockFindFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ kind: NO_REPLY_KIND })
    }
  })
})

describe("BKL-211 journal isolation — the no-reply backstop is not regressed", () => {
  beforeEach(() => vi.clearAllMocks())

  // THE regression this design exists to prevent. A security_probe row never
  // auto-closes, so it sits OPEN on the session indefinitely. If the journals
  // shared one per-session slot, this later genuine ghost would be folded into it
  // as a dropCount increment — `opened:false`, no `conversation.incident_opened`
  // publish, and therefore NO staff ping for a real customer-facing outage.
  it("a genuine ghost still OPENS a fresh no_reply incident while a security probe is open", async () => {
    mockFindUnique.mockResolvedValue(null)
    // The kind-scoped lookups find nothing: the session's only open row is the
    // security one, which is invisible to a no_reply-scoped query.
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockResolvedValue(makeRow({ id: "inc_ghost" }))

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(
      systemOpenEnv({
        sessionId: SESSION,
        cause: "empty_completion",
        channel: "whatsapp",
        externalId: "conversation.no_delivery:wa:5511999999999:turn_9",
      }),
      state,
    )

    // A genuinely NEW open → the staff-ping fan-out still fires upstream.
    expect(out.result?.opened).toBe(true)
    expect(mockCreate).toHaveBeenCalled()
  })

  it("a repeat security probe on the same session still folds into ONE row (dropCount++)", async () => {
    mockFindUnique.mockResolvedValue(null) // a DIFFERENT event id, so not a replay
    mockFindFirst.mockResolvedValue(
      makeRow({ id: "inc_sec", kind: SECURITY_PROBE_KIND, cause: "security_probe", customerImpacted: false }),
    )
    mockUpdate.mockResolvedValue(makeRow({ id: "inc_sec", kind: SECURITY_PROBE_KIND }))

    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(
      systemOpenEnv(securityPayload({ externalId: "security.probe_refused:wa:5511999999999:hash_2" })),
      state,
    )

    // Folded, not a second row — the inbox never storms on one attacked session.
    expect(out.result?.opened).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inc_sec" },
        data: expect.objectContaining({ dropCount: { increment: 1 } }),
      }),
    )
  })
})

describe("BKL-211 AUTO-CLOSE EXEMPTION — a delivered reply must not close an attack row", () => {
  beforeEach(() => vi.clearAllMocks())

  // `findOpenBySession` is the single lookup behind every delivered-reply close
  // seam (closeIncidentOnDeliveredReply / closeIncidentOnStaffReply /
  // resolveIncidentOnHandoff — all route through closeActiveIncident). Scoping it
  // to no_reply IS the exemption: a security_probe row is simply never returned,
  // so the close never has an id to act on.
  it("findOpenBySession queries ONLY the no_reply journal", async () => {
    mockFindFirst.mockResolvedValue(null)

    const svc = createIncidentService()
    await svc.findOpenBySession(SESSION)

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sessionId: SESSION, kind: NO_REPLY_KIND }),
      }),
    )
  })

  it("a session whose ONLY open row is a security probe yields no close target", async () => {
    // The kind-scoped query does not match the security row → null → the caller
    // (closeActiveIncident) returns early and no incident.ticket.close is built.
    mockFindFirst.mockResolvedValue(null)

    const svc = createIncidentService()
    expect(await svc.findOpenBySession(SESSION)).toBeNull()
  })
})

describe("BKL-211 cause⇄journal coupling — fails CLOSED at the kernel", () => {
  beforeEach(() => vi.clearAllMocks())

  it("REFUSEs a security_probe cause smuggled onto the no_reply journal", async () => {
    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(
      systemOpenEnv(securityPayload({ kind: NO_REPLY_KIND })),
      state,
    )

    // Were this allowed, the very refusal reply that opened the row would
    // AUTO_RESOLVE it inside the same turn and staff would never see the attack.
    expect(out.decision.kind).toBe("REFUSE")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("REFUSEs a delivery-failure cause smuggled onto the security journal", async () => {
    const svc = createIncidentService()
    const out = await svc.openIncidentFromEnvelope(
      systemOpenEnv({
        sessionId: SESSION,
        cause: "empty_completion",
        kind: SECURITY_PROBE_KIND,
        channel: "whatsapp",
        externalId: "conversation.no_delivery:wa:5511999999999:turn_3",
      }),
      state,
    )

    // Were this allowed the ghost would never self-heal AND it would occupy the
    // security slot — the mirror-image failure.
    expect(out.decision.kind).toBe("REFUSE")
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
