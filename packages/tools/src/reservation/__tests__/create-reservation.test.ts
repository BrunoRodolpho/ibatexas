// Tests for create_reservation tool
// Mock-based; no database required.
//
// Scenarios:
// - Slot not found → throws
// - Insufficient capacity → throws
// - Happy path → creates reservation, publishes NATS, returns confirmation
// - WhatsApp stub is called with correct reservation DTO

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn())
const mockTableFindMany = vi.hoisted(() => vi.fn())
const mockReservationTableFindMany = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockSendReservationConfirmation = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    timeSlot: { findUnique: mockTimeSlotFindUnique },
    table: { findMany: mockTableFindMany },
    reservationTable: { findMany: mockReservationTableFindMany },
    $transaction: mockTransaction,
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// Mock notifications stub
vi.mock("../notifications.js", () => ({
  sendReservationConfirmation: mockSendReservationConfirmation,
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { createReservation } from "../create-reservation.js"

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

const TABLES = [
  { id: "tbl_01", number: "1", capacity: 4, location: "indoor", accessible: false, active: true, createdAt: new Date() },
  { id: "tbl_02", number: "2", capacity: 4, location: "outdoor", accessible: false, active: true, createdAt: new Date() },
]

function makeCreatedReservation(overrides = {}) {
  return {
    id: "res_01",
    customerId: "cus_01",
    partySize: 4,
    status: "confirmed",
    specialRequests: [],
    confirmedAt: new Date(),
    checkedInAt: null,
    cancelledAt: null,
    timeSlotId: "ts_01",
    createdAt: new Date(),
    updatedAt: new Date(),
    timeSlot: SLOT,
    tables: [{ reservationId: "res_01", tableId: "tbl_01", table: TABLES[0] }],
    ...overrides,
  }
}

const BASE_INPUT = {
  customerId: "cus_01",
  timeSlotId: "ts_01",
  partySize: 4,
  specialRequests: [],
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createReservation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockSendReservationConfirmation.mockResolvedValue(undefined)
    // Default: tables available, none reserved currently
    mockTableFindMany.mockResolvedValue(TABLES)
    mockReservationTableFindMany.mockResolvedValue([])
    // Default transaction: return created reservation
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const mockTx = {
        reservation: {
          create: vi.fn().mockResolvedValue(makeCreatedReservation()),
        },
        timeSlot: {
          update: vi.fn().mockResolvedValue(undefined),
        },
      }
      return cb(mockTx)
    })
  })

  it("throws when time slot is not found", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(null)

    await expect(createReservation(BASE_INPUT)).rejects.toThrow("Horário não encontrado")
  })

  it("throws when slot has insufficient capacity", async () => {
    mockTimeSlotFindUnique.mockResolvedValue({
      ...SLOT,
      maxCovers: 10,
      reservedCovers: 8, // only 2 available, need 4
    })

    await expect(createReservation(BASE_INPUT)).rejects.toThrow("esgotado")
  })

  it("returns confirmation DTO on success", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)

    const result = await createReservation(BASE_INPUT)

    expect(result.reservationId).toBe("res_01")
    expect(result.confirmed).toBe(true)
    expect(result.partySize).toBe(4)
    expect(result.confirmationMessage).toContain("Reserva confirmada")
  })

  it("publishes reservation.created NATS event", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)

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
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)

    await createReservation(BASE_INPUT)

    expect(mockSendReservationConfirmation).toHaveBeenCalledOnce()
    const [dto] = mockSendReservationConfirmation.mock.calls[0] as [{ id: string; partySize: number }]
    expect(dto.id).toBe("res_01")
    expect(dto.partySize).toBe(4)
  })

  it("runs db changes inside a transaction", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)

    await createReservation(BASE_INPUT)

    expect(mockTransaction).toHaveBeenCalledOnce()
  })
})
