// Tests for join_waitlist tool (W7 follow-up — envelope-routed)
// Mock-based; no database required.
//
// Scenarios:
// - Kernel REFUSE on invalid party size → throws with refusal copy
// - Happy path → returns position + message, envelope built correctly
// - Idempotent existing-waitlist case (executor wired through pack EXECUTE)
// - Envelope shape: kind="reservation.waitlist.join", taint="UNTRUSTED", principal="llm"

import { describe, it, expect, beforeEach, vi } from "vitest"
import { joinWaitlist } from "../join-waitlist.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockJoinWaitlistFromEnvelope = vi.hoisted(() => vi.fn())
// BKL-046: sentinel audit sink returned by the mocked `getAuditSink()`; the
// factory-spy below asserts the tool threads it into `createReservationService`.
const mockAuditSink = vi.hoisted(() => ({ emit: vi.fn() }))
const mockGetAuditSink = vi.hoisted(() => vi.fn(() => mockAuditSink))
const mockCreateReservationService = vi.hoisted(() =>
  vi.fn((_options?: { auditSink?: unknown }) => ({
    joinWaitlistFromEnvelope: mockJoinWaitlistFromEnvelope,
  })),
)

vi.mock("@ibatexas/domain", () => ({
  prisma: {},
  createReservationService: mockCreateReservationService,
}))

vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: mockGetAuditSink,
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BASE_INPUT = {
  customerId: "cus_01",
  timeSlotId: "ts_01",
  partySize: 2,
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("joinWaitlist", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("throws when kernel REFUSEs (e.g., invalid party size)", async () => {
    mockJoinWaitlistFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "invalid_party_size",
          userFacing: "Tamanho de grupo inválido.",
        },
      },
    })

    await expect(joinWaitlist(BASE_INPUT)).rejects.toThrow("Tamanho de grupo inválido")
  })

  it("returns waitlist entry on EXECUTE happy path", async () => {
    mockJoinWaitlistFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { waitlistId: "wl_02", position: 1 },
    })

    const result = await joinWaitlist(BASE_INPUT)

    expect(result.waitlistId).toBe("wl_02")
    expect(result.position).toBe(1)
    expect(result.message).toContain("posição: 1")
  })

  it("returns position > 1 with the multi-waiter copy", async () => {
    mockJoinWaitlistFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { waitlistId: "wl_05", position: 3 },
    })

    const result = await joinWaitlist(BASE_INPUT)

    expect(result.position).toBe(3)
    expect(result.message).toContain("posição 3")
  })

  it("routes through joinWaitlistFromEnvelope with the correct envelope shape", async () => {
    mockJoinWaitlistFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { waitlistId: "wl_99", position: 1 },
    })

    await joinWaitlist(BASE_INPUT)

    expect(mockJoinWaitlistFromEnvelope).toHaveBeenCalledOnce()
    const [envelope, state, extras] = mockJoinWaitlistFromEnvelope.mock.calls[0] as [
      {
        kind: string
        taint: string
        actor: { principal: string; sessionId: string }
        payload: { timeSlotId: string; partySize: number }
      },
      { ctx: { customerId: string; channel: string; staffId: string | null } },
      { customerId: string },
    ]

    expect(envelope.kind).toBe("reservation.waitlist.join")
    expect(envelope.taint).toBe("UNTRUSTED")
    expect(envelope.actor.principal).toBe("llm")
    expect(envelope.actor.sessionId).toBe("customer:cus_01")
    expect(envelope.payload.timeSlotId).toBe("ts_01")
    expect(envelope.payload.partySize).toBe(2)

    expect(state.ctx.channel).toBe("whatsapp")
    expect(state.ctx.customerId).toBe("cus_01")
    expect(state.ctx.staffId).toBeNull()

    expect(extras.customerId).toBe("cus_01")
  })

  // BKL-046: `createReservationService()` silently drops audit emission when no
  // sink is supplied, so the kernel EXECUTE for `reservation.waitlist.join`
  // produced no intent_audit record. Regression: assert the factory receives the
  // sink resolved via `getAuditSink()`.
  it("constructs the reservation service with the configured audit sink", async () => {
    mockJoinWaitlistFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { waitlistId: "wl_01", position: 1 },
    })

    await joinWaitlist(BASE_INPUT)

    expect(mockGetAuditSink).toHaveBeenCalled()
    expect(mockCreateReservationService).toHaveBeenCalledOnce()
    const options = mockCreateReservationService.mock.calls[0]?.[0]
    expect(options?.auditSink).toBe(mockAuditSink)
  })
})
