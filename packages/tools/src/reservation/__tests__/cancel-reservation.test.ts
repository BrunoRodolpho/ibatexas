// Tests for cancel_reservation tool (W7 P1 — envelope-routed)
// Mock-based; no database required.
//
// Scenarios:
// - Ownership guard rejects unknown reservation / wrong owner (pre-kernel)
// - Kernel REFUSE on terminal status → {success: false} with refusal copy
// - Kernel REQUEST_CONFIRMATION on last-minute cancel → {success: false} with prompt
// - Happy path → {success: true}, NATS published, waitlist promoted
// - Envelope shape: kind="reservation.cancel", taint="UNTRUSTED", principal="llm"

import { describe, it, expect, beforeEach, vi } from "vitest"
import { cancelReservation } from "../cancel-reservation.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockReservationFindUnique = vi.hoisted(() => vi.fn())
const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn())
const mockSvcGetById = vi.hoisted(() => vi.fn())
const mockCancelFromEnvelope = vi.hoisted(() => vi.fn())
const mockPromoteWaitlist = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockNotifyWaitlistSpotAvailable = vi.hoisted(() => vi.fn())
const mockSendReservationCancelled = vi.hoisted(() => vi.fn())
// BKL-046: sentinel audit sink returned by the mocked `getAuditSink()`; the
// factory-spy below asserts the tool threads it into `createReservationService`.
const mockAuditSink = vi.hoisted(() => ({ emit: vi.fn() }))
const mockGetAuditSink = vi.hoisted(() => vi.fn(() => mockAuditSink))
const mockCreateReservationService = vi.hoisted(() =>
  vi.fn((_options?: { auditSink?: unknown }) => ({
    getById: mockSvcGetById,
    cancelFromEnvelope: mockCancelFromEnvelope,
    promoteWaitlist: mockPromoteWaitlist,
  })),
)

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: {
      findUnique: mockReservationFindUnique,
    },
    timeSlot: { findUnique: mockTimeSlotFindUnique },
  },
  createReservationService: mockCreateReservationService,
}))

vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: mockGetAuditSink,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

vi.mock("../notifications.js", () => ({
  notifyWaitlistSpotAvailable: mockNotifyWaitlistSpotAvailable,
  sendReservationConfirmation: vi.fn(),
  sendReservationCancelled: mockSendReservationCancelled,
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const OWNERSHIP_RESERVATION = {
  id: "res_01",
  customerId: "cus_01",
}

const RESERVATION_DTO = {
  id: "res_01",
  customerId: "cus_01",
  partySize: 4,
  status: "confirmed" as const,
  specialRequests: [],
  timeSlot: {
    id: "ts_01",
    date: "2026-03-15",
    startTime: "19:30",
    durationMinutes: 90,
  },
  tableLocation: null,
  confirmedAt: null,
  checkedInAt: null,
  cancelledAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const SLOT = {
  id: "ts_01",
  date: new Date("2026-03-15T00:00:00.000Z"),
  startTime: "19:30",
  durationMinutes: 90,
  maxCovers: 40,
  reservedCovers: 4,
}

function setupHappyPath() {
  mockReservationFindUnique.mockResolvedValue(OWNERSHIP_RESERVATION)
  mockSvcGetById.mockResolvedValue(RESERVATION_DTO)
  mockTimeSlotFindUnique.mockResolvedValue(SLOT)
  mockCancelFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE" },
    result: { timeSlotId: "ts_01", partySize: 4 },
  })
  mockPromoteWaitlist.mockResolvedValue({ promoted: null })
  mockPublishNatsEvent.mockResolvedValue(undefined)
  mockNotifyWaitlistSpotAvailable.mockResolvedValue(undefined)
  mockSendReservationCancelled.mockResolvedValue(undefined)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("cancelReservation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("throws 'não encontrada' when reservation not found (SEC-002 guard)", async () => {
    mockReservationFindUnique.mockResolvedValue(null)

    await expect(
      cancelReservation({ customerId: "cus_01", reservationId: "res_99" }),
    ).rejects.toThrow("não encontrada")
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
  })

  it("throws 'Acesso negado' for wrong owner (SEC-002 guard)", async () => {
    mockReservationFindUnique.mockResolvedValue(OWNERSHIP_RESERVATION)

    await expect(
      cancelReservation({ customerId: "cus_WRONG", reservationId: "res_01" }),
    ).rejects.toThrow("Acesso negado")
    expect(mockCancelFromEnvelope).not.toHaveBeenCalled()
  })

  it("returns success:false when kernel REFUSEs (already cancelled)", async () => {
    mockReservationFindUnique.mockResolvedValue(OWNERSHIP_RESERVATION)
    mockSvcGetById.mockResolvedValue({ ...RESERVATION_DTO, status: "cancelled" })
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)
    mockCancelFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "reservation_not_cancellable",
          userFacing: 'Não é possível cancelar reserva com status "cancelled".',
        },
      },
    })

    const result = await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(result.success).toBe(false)
    expect(result.message).toContain("cancelled")
  })

  it("returns success:false when kernel REFUSEs (completed)", async () => {
    mockReservationFindUnique.mockResolvedValue(OWNERSHIP_RESERVATION)
    mockSvcGetById.mockResolvedValue({ ...RESERVATION_DTO, status: "completed" })
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)
    mockCancelFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "reservation_not_cancellable",
          userFacing: 'Não é possível cancelar reserva com status "completed".',
        },
      },
    })

    const result = await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(result.success).toBe(false)
  })

  it("returns success:true and publishes NATS event on happy path", async () => {
    setupHappyPath()

    const result = await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(result.success).toBe(true)
    expect(mockCancelFromEnvelope).toHaveBeenCalledOnce()
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "reservation.cancelled",
      expect.objectContaining({
        customerId: "cus_01",
        metadata: expect.objectContaining({ reservationId: "res_01" }),
      }),
    )
  })

  it("notifies next waitlist entry if one exists", async () => {
    setupHappyPath()
    mockPromoteWaitlist.mockResolvedValue({
      promoted: {
        id: "wl_01",
        customerId: "cus_02",
        partySize: 2,
        date: "2026-03-15",
        startTime: "19:30",
      },
    })

    await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(mockNotifyWaitlistSpotAvailable).toHaveBeenCalledOnce()
  })

  it("does not call notifyWaitlistSpotAvailable when no one is waiting", async () => {
    setupHappyPath()

    await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(mockNotifyWaitlistSpotAvailable).not.toHaveBeenCalled()
  })

  it("routes through cancelFromEnvelope with the correct envelope shape", async () => {
    setupHappyPath()

    await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(mockCancelFromEnvelope).toHaveBeenCalledOnce()
    const [envelope, state, extras] = mockCancelFromEnvelope.mock.calls[0] as [
      { kind: string; taint: string; actor: { principal: string; sessionId: string }; payload: { reservationId: string } },
      { ctx: { reservation: { id: string; status: string } | null; slot: unknown } },
      { customerId: string },
    ]

    expect(envelope.kind).toBe("reservation.cancel")
    expect(envelope.taint).toBe("UNTRUSTED")
    expect(envelope.actor.principal).toBe("llm")
    expect(envelope.payload.reservationId).toBe("res_01")

    expect(state.ctx.reservation).not.toBeNull()
    expect(state.ctx.reservation!.id).toBe("res_01")
    expect(state.ctx.reservation!.status).toBe("confirmed")
    // Slot projection feeds the last-minute-confirm guard.
    expect(state.ctx.slot).not.toBeNull()

    expect(extras.customerId).toBe("cus_01")
  })

  // BKL-046: `createReservationService()` silently drops audit emission when no
  // sink is supplied, so the kernel EXECUTE for `reservation.cancel` produced no
  // intent_audit record. Regression: assert the factory receives the sink
  // resolved via `getAuditSink()`.
  it("constructs the reservation service with the configured audit sink", async () => {
    setupHappyPath()

    await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(mockGetAuditSink).toHaveBeenCalled()
    expect(mockCreateReservationService).toHaveBeenCalledOnce()
    const options = mockCreateReservationService.mock.calls[0]?.[0]
    expect(options?.auditSink).toBe(mockAuditSink)
  })
})
