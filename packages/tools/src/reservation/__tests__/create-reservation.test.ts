// Tests for create_reservation tool (W7 P1 — envelope-routed)
// Mock-based; no database required.
//
// Scenarios:
// - Slot not found → kernel REFUSE → throws with refusal copy
// - Kernel REFUSE on insufficient capacity → throws
// - Happy path → routes through createFromEnvelope, publishes NATS, returns confirmation
// - WhatsApp stub is called with correct reservation DTO
// - Envelope shape: kind="reservation.create", taint="UNTRUSTED", principal="llm"

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  createReservation,
  createReservationPreAdjudicated,
} from "../create-reservation.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn())
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockSendReservationConfirmation = vi.hoisted(() => vi.fn())
// BKL-046: sentinel audit sink returned by the mocked `getAuditSink()`; the
// factory-spy below asserts the tool threads it into `createReservationService`.
const mockAuditSink = vi.hoisted(() => ({ emit: vi.fn() }))
const mockGetAuditSink = vi.hoisted(() => vi.fn(() => mockAuditSink))
const mockCreateReservationService = vi.hoisted(() =>
  vi.fn((_options?: { auditSink?: unknown }) => ({
    createFromEnvelope: mockCreateFromEnvelope,
    create: mockCreate,
  })),
)

vi.mock("@ibatexas/domain", () => ({
  prisma: {
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

// Mock notifications stub
vi.mock("../notifications.js", () => ({
  sendReservationConfirmation: mockSendReservationConfirmation,
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SLOT = {
  id: "ts_01",
  date: new Date("2026-03-15T00:00:00.000Z"),
  startTime: "19:30",
  durationMinutes: 90,
  maxCovers: 40,
  reservedCovers: 0,
  createdAt: new Date(),
}

const TABLE_LOCATION = "indoor"

function makeReservationDTO() {
  return {
    id: "res_01",
    displayId: 1,
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
    tableLocation: TABLE_LOCATION,
    confirmedAt: new Date().toISOString(),
    checkedInAt: null,
    cancelledAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const BASE_INPUT = {
  customerId: "cus_01",
  timeSlotId: "ts_01",
  partySize: 4,
  specialRequests: [],
}

function setupHappyPath() {
  mockTimeSlotFindUnique.mockResolvedValue(SLOT)
  mockCreateFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE" },
    result: { reservation: makeReservationDTO(), tableLocation: TABLE_LOCATION },
  })
  mockPublishNatsEvent.mockResolvedValue(undefined)
  mockSendReservationConfirmation.mockResolvedValue(undefined)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createReservation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("throws with kernel REFUSE copy when slot is not found", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(null)
    mockCreateFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "reservation_slot_not_found",
          userFacing: "Horário não encontrado. Verifique o ID do horário.",
        },
      },
    })

    await expect(createReservation(BASE_INPUT)).rejects.toThrow("Horário não encontrado")
  })

  it("throws with kernel REFUSE copy when slot has insufficient capacity", async () => {
    mockTimeSlotFindUnique.mockResolvedValue({ ...SLOT, maxCovers: 10, reservedCovers: 8 })
    mockCreateFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "reservation_slot_full",
          userFacing:
            "Este horário está esgotado para 4 pessoa(s). Tente outro horário ou entre na lista de espera.",
        },
      },
    })

    await expect(createReservation(BASE_INPUT)).rejects.toThrow("esgotado")
  })

  it("returns confirmation DTO on success", async () => {
    setupHappyPath()

    const result = await createReservation(BASE_INPUT)

    expect(result.reservationId).toBe("res_01")
    expect(result.confirmed).toBe(true)
    expect(result.partySize).toBe(4)
    expect(result.confirmationMessage).toContain("Reserva confirmada")
  })

  it("publishes reservation.created NATS event", async () => {
    setupHappyPath()

    await createReservation(BASE_INPUT)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "reservation.created",
      expect.objectContaining({
        eventType: "reservation.created",
        customerId: "cus_01",
        metadata: expect.objectContaining({ reservationId: "res_01" }),
      }),
    )
  })

  it("calls sendReservationConfirmation with correct data", async () => {
    setupHappyPath()

    await createReservation(BASE_INPUT)

    expect(mockSendReservationConfirmation).toHaveBeenCalledOnce()
    const [dto] = mockSendReservationConfirmation.mock.calls[0] as [{ id: string; partySize: number }]
    expect(dto.id).toBe("res_01")
    expect(dto.partySize).toBe(4)
  })

  it("routes through createFromEnvelope with the correct envelope shape", async () => {
    setupHappyPath()

    await createReservation(BASE_INPUT)

    expect(mockCreateFromEnvelope).toHaveBeenCalledOnce()
    const [envelope, state, extras] = mockCreateFromEnvelope.mock.calls[0] as [
      { kind: string; taint: string; actor: { principal: string; sessionId: string }; payload: { timeSlotId: string; partySize: number } },
      { ctx: { customerId: string; slot: { timeSlotId: string; maxCovers: number; reservedCovers: number } | null } },
      { customerId: string },
    ]

    // Envelope: kernel-gated mutation. UNTRUSTED + principal=llm is the
    // canonical LLM-tool dispatch shape per CLAUDE.md rule #9.
    expect(envelope.kind).toBe("reservation.create")
    expect(envelope.taint).toBe("UNTRUSTED")
    expect(envelope.actor.principal).toBe("llm")
    expect(envelope.actor.sessionId).toBe("customer:cus_01")
    expect(envelope.payload.timeSlotId).toBe("ts_01")
    expect(envelope.payload.partySize).toBe(4)

    // State projection: the pack's `requireSlotWithCapacity` reads
    // state.ctx.slot. Without it, the kernel would REFUSE before the
    // executor ever runs.
    expect(state.ctx.customerId).toBe("cus_01")
    expect(state.ctx.slot).not.toBeNull()
    expect(state.ctx.slot!.maxCovers).toBe(40)
    expect(state.ctx.slot!.reservedCovers).toBe(0)

    expect(extras.customerId).toBe("cus_01")
  })

  // BKL-046: `createReservationService()` silently drops audit emission when no
  // sink is supplied, so the kernel EXECUTE for `reservation.create` produced no
  // intent_audit record. The tool must thread the configured AuditSink into the
  // service factory. Regression: assert the factory receives the sink resolved
  // via `getAuditSink()`.
  it("constructs the reservation service with the configured audit sink", async () => {
    setupHappyPath()

    await createReservation(BASE_INPUT)

    expect(mockGetAuditSink).toHaveBeenCalled()
    expect(mockCreateReservationService).toHaveBeenCalledOnce()
    const options = mockCreateReservationService.mock.calls[0]?.[0]
    expect(options?.auditSink).toBe(mockAuditSink)
  })
})

// BKL-243 — the conductor-dispatch entry point. Registry dispatch runs on a
// kernel EXECUTE the Conductor already audited and ledger-claimed; re-minting an
// envelope here adjudicated the same `reservation.create` intent a second time.
// Same class and same fix shape as BKL-232 (`reservation.modify`, PR #386).
describe("createReservationPreAdjudicated (BKL-243)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setupPreAdjudicatedHappyPath() {
    mockCreate.mockResolvedValue({
      reservation: makeReservationDTO(),
      tableLocation: TABLE_LOCATION,
    })
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockSendReservationConfirmation.mockResolvedValue(undefined)
  }

  it("writes via the bare service method and NEVER re-adjudicates", async () => {
    setupPreAdjudicatedHappyPath()

    const result = await createReservationPreAdjudicated(BASE_INPUT)

    // No second envelope, no second kernel run, no second audit record.
    expect(mockCreateFromEnvelope).not.toHaveBeenCalled()
    // The mutation still runs exactly once, with the customerId carried in the
    // payload (the reservation handlers assert ownership themselves).
    expect(mockCreate).toHaveBeenCalledExactlyOnceWith({
      customerId: "cus_01",
      timeSlotId: "ts_01",
      partySize: 4,
      specialRequests: [],
    })
    // Same success shape + side effects as the self-adjudicating entry point.
    expect(result.confirmed).toBe(true)
    expect(result.reservationId).toBe("res_01")
    expect(result.confirmationMessage).toContain("Reserva confirmada")
    expect(mockSendReservationConfirmation).toHaveBeenCalledOnce()
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "reservation.created",
      expect.objectContaining({ eventType: "reservation.created" }),
    )
  })

  // The slot row exists ONLY to feed the pack's `requireSlotWithCapacity` /
  // `requireSlotInFuture` guards. With no kernel run on this path it is a pure
  // wasted read — `svc.create` re-reads the slot FOR UPDATE regardless.
  it("skips the kernel-only slot hydration", async () => {
    setupPreAdjudicatedHappyPath()

    await createReservationPreAdjudicated(BASE_INPUT)

    expect(mockTimeSlotFindUnique).not.toHaveBeenCalled()
  })

  it("propagates a write failure instead of reporting a reservation that never committed", async () => {
    mockCreate.mockRejectedValue(new Error("Horário esgotado."))

    await expect(createReservationPreAdjudicated(BASE_INPUT)).rejects.toThrow(
      "Horário esgotado.",
    )
    expect(mockSendReservationConfirmation).not.toHaveBeenCalled()
  })
})
