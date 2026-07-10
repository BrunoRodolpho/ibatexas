// Tests for modify_reservation tool (W7 P1 — envelope-routed)
// Mock-based; no database required.
//
// Scenarios:
// - Ownership guard rejects unknown reservation / wrong owner (pre-kernel)
// - Kernel REFUSE on terminal status → {success: false} with refusal copy
// - Kernel REFUSE on new slot not found / no capacity → {success: false}
// - Happy path → {success: true, reservation: dto}, NATS published, envelope routed

import { describe, it, expect, beforeEach, vi } from "vitest"
import { modifyReservation } from "../modify-reservation.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockReservationFindUnique = vi.hoisted(() => vi.fn())
const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn())
const mockModifyFromEnvelope = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockSendReservationModified = vi.hoisted(() => vi.fn())
// BKL-046: sentinel audit sink returned by the mocked `getAuditSink()`; the
// factory-spy below asserts the tool threads it into `createReservationService`.
const mockAuditSink = vi.hoisted(() => ({ emit: vi.fn() }))
const mockGetAuditSink = vi.hoisted(() => vi.fn(() => mockAuditSink))
const mockCreateReservationService = vi.hoisted(() =>
  vi.fn((_options?: { auditSink?: unknown }) => ({
    modifyFromEnvelope: mockModifyFromEnvelope,
  })),
)

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: { findUnique: mockReservationFindUnique },
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
  sendReservationModified: mockSendReservationModified,
  sendReservationConfirmation: vi.fn(),
  sendReservationCancelled: vi.fn(),
  notifyWaitlistSpotAvailable: vi.fn(),
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const EXISTING_RESERVATION = {
  id: "res_01",
  customerId: "cus_01",
  partySize: 4,
  status: "confirmed",
  timeSlotId: "ts_01",
}

const EXISTING_RESERVATION_FULL = {
  ...EXISTING_RESERVATION,
  specialRequests: [],
  timeSlot: {
    id: "ts_01",
    date: new Date("2026-03-15T00:00:00.000Z"),
    startTime: "19:30",
    durationMinutes: 90,
  },
  tables: [],
  confirmedAt: new Date(),
  checkedInAt: null,
  cancelledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const NEW_SLOT = {
  id: "ts_02",
  date: new Date("2026-03-16T00:00:00.000Z"),
  startTime: "20:00",
  durationMinutes: 90,
  maxCovers: 40,
  reservedCovers: 0,
  createdAt: new Date(),
}

const MOCK_DTO = {
  id: "res_01",
  customerId: "cus_01",
  partySize: 4,
  status: "confirmed" as const,
  specialRequests: [],
  timeSlot: { id: "ts_02", date: "2026-03-16", startTime: "20:00", durationMinutes: 90 },
  tableLocation: null,
  confirmedAt: null,
  checkedInAt: null,
  cancelledAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function setupHappyPath() {
  // withReservationOwnership uses prisma.reservation.findUnique to assert ownership BEFORE the impl runs.
  mockReservationFindUnique.mockResolvedValue(EXISTING_RESERVATION_FULL)
  mockTimeSlotFindUnique.mockResolvedValue(NEW_SLOT)
  mockModifyFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE" },
    result: MOCK_DTO,
  })
  mockSendReservationModified.mockResolvedValue(undefined)
  mockPublishNatsEvent.mockResolvedValue(undefined)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("modifyReservation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("throws 'não encontrada' when reservation not found (SEC-002 guard)", async () => {
    mockReservationFindUnique.mockResolvedValue(null)

    await expect(
      modifyReservation({ customerId: "cus_01", reservationId: "res_99" }),
    ).rejects.toThrow("não encontrada")
  })

  it("throws 'Acesso negado' for wrong owner (SEC-002 guard)", async () => {
    mockReservationFindUnique.mockResolvedValue(EXISTING_RESERVATION_FULL)

    await expect(
      modifyReservation({ customerId: "cus_WRONG", reservationId: "res_01" }),
    ).rejects.toThrow("Acesso negado")
  })

  it("returns success:false when kernel REFUSEs (e.g. terminal status)", async () => {
    mockReservationFindUnique.mockResolvedValue({ ...EXISTING_RESERVATION_FULL, status: "cancelled" })
    mockTimeSlotFindUnique.mockResolvedValue(null)
    mockModifyFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "reservation_not_modifiable",
          userFacing: 'Não é possível modificar reserva com status "cancelled".',
        },
      },
    })

    const result = await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("Não é possível modificar")
    expect(result.reservation).toBeNull()
  })

  it("returns success:false when kernel REFUSEs new-slot-full", async () => {
    mockReservationFindUnique.mockResolvedValue(EXISTING_RESERVATION_FULL)
    mockTimeSlotFindUnique.mockResolvedValue({ ...NEW_SLOT, maxCovers: 10, reservedCovers: 10 })
    mockModifyFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "reservation_slot_full",
          userFacing: "O horário solicitado não tem vagas suficientes.",
        },
      },
    })

    const result = await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
      newTimeSlotId: "ts_02",
      newPartySize: 4,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("vagas")
  })

  it("returns success:true with DTO on happy path", async () => {
    setupHappyPath()

    const result = await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
      newTimeSlotId: "ts_02",
    })

    expect(result.success).toBe(true)
    expect(result.reservation).not.toBeNull()
    expect(result.message).toContain("modificada")
  })

  it("publishes reservation.modified NATS event", async () => {
    setupHappyPath()

    await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
      newTimeSlotId: "ts_02",
    })

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "reservation.modified",
      expect.objectContaining({ eventType: "reservation.modified" }),
    )
  })

  it("routes through modifyFromEnvelope with the correct envelope shape", async () => {
    setupHappyPath()

    await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
      newTimeSlotId: "ts_02",
    })

    expect(mockModifyFromEnvelope).toHaveBeenCalledOnce()
    const [envelope, state, extras] = mockModifyFromEnvelope.mock.calls[0] as [
      { kind: string; taint: string; actor: { principal: string; sessionId: string }; payload: { reservationId: string; newTimeSlotId?: string } },
      { ctx: { reservation: { id: string; status: string; timeSlotId: string } | null; newSlot: unknown } },
      { customerId: string },
    ]

    expect(envelope.kind).toBe("reservation.modify")
    expect(envelope.taint).toBe("UNTRUSTED")
    expect(envelope.actor.principal).toBe("llm")
    expect(envelope.payload.reservationId).toBe("res_01")
    expect(envelope.payload.newTimeSlotId).toBe("ts_02")

    expect(state.ctx.reservation).not.toBeNull()
    expect(state.ctx.reservation!.id).toBe("res_01")
    expect(state.ctx.reservation!.status).toBe("confirmed")
    expect(state.ctx.newSlot).not.toBeNull()

    expect(extras.customerId).toBe("cus_01")
  })

  // BKL-046: `createReservationService()` silently drops audit emission when no
  // sink is supplied, so the kernel EXECUTE for `reservation.modify` produced no
  // intent_audit record. Regression: assert the factory receives the sink
  // resolved via `getAuditSink()`.
  it("constructs the reservation service with the configured audit sink", async () => {
    setupHappyPath()

    await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
      newTimeSlotId: "ts_02",
    })

    expect(mockGetAuditSink).toHaveBeenCalled()
    expect(mockCreateReservationService).toHaveBeenCalledOnce()
    const options = mockCreateReservationService.mock.calls[0]?.[0]
    expect(options?.auditSink).toBe(mockAuditSink)
  })
})
