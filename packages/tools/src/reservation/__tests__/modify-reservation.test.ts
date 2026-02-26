// Tests for modify_reservation tool
// Mock-based; no database required.
//
// Scenarios:
// - Not found → {success: false}
// - Wrong owner → {success: false}
// - Terminal status (cancelled/no_show/completed) → {success: false}
// - New time slot not found → {success: false}
// - New slot insufficient capacity → {success: false}
// - Happy path → {success: true, reservation: dto}, NATS published

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Mock } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockReservationFindUnique = vi.hoisted(() => vi.fn())
const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockAssignTables = vi.hoisted(() => vi.fn())
const mockReleaseReservation = vi.hoisted(() => vi.fn())
const mockReservationToDTO = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: { findUnique: mockReservationFindUnique },
    timeSlot: { findUnique: mockTimeSlotFindUnique },
    $transaction: mockTransaction,
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

vi.mock("../utils.js", () => ({
  assignTables: mockAssignTables,
  releaseReservation: mockReleaseReservation,
  reservationToDTO: mockReservationToDTO,
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { modifyReservation } from "../modify-reservation.js"

// ── Fixtures ───────────────────────────────────────────────────────────────────

const EXISTING_RESERVATION = {
  id: "res_01",
  customerId: "cus_01",
  partySize: 4,
  status: "confirmed",
  specialRequests: [],
  timeSlotId: "ts_01",
  timeSlot: {
    id: "ts_01",
    date: new Date("2026-03-15T00:00:00.000Z"),
    startTime: "19:30",
    durationMinutes: 90,
    maxCovers: 40,
    reservedCovers: 4,
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
  mockReservationFindUnique.mockResolvedValue(EXISTING_RESERVATION)
  mockTimeSlotFindUnique.mockResolvedValue(NEW_SLOT)
  mockAssignTables.mockResolvedValue(["tbl_01"])
  mockReservationToDTO.mockReturnValue(MOCK_DTO)
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const mockTx = {
      timeSlot: { update: vi.fn().mockResolvedValue(undefined) },
      reservationTable: { deleteMany: vi.fn().mockResolvedValue(undefined) },
      reservation: { update: vi.fn().mockResolvedValue({ ...EXISTING_RESERVATION, timeSlotId: "ts_02" }) },
    }
    return cb(mockTx)
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("modifyReservation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  it("returns success:false when reservation not found", async () => {
    mockReservationFindUnique.mockResolvedValue(null)

    const result = await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_99",
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("não encontrada")
  })

  it("returns success:false for wrong owner", async () => {
    mockReservationFindUnique.mockResolvedValue(EXISTING_RESERVATION)

    const result = await modifyReservation({
      customerId: "cus_WRONG",
      reservationId: "res_01",
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("permissão")
  })

  it("returns success:false when status is cancelled", async () => {
    mockReservationFindUnique.mockResolvedValue({ ...EXISTING_RESERVATION, status: "cancelled" })

    const result = await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("Não é possível modificar")
    expect(result.reservation).toBeNull()
  })

  it("returns success:false when new slot not found", async () => {
    mockReservationFindUnique.mockResolvedValue(EXISTING_RESERVATION)
    mockTimeSlotFindUnique.mockResolvedValue(null)

    const result = await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
      newTimeSlotId: "ts_NONEXISTENT",
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("Novo horário não encontrado")
  })

  it("returns success:false when new slot has no capacity", async () => {
    mockReservationFindUnique.mockResolvedValue(EXISTING_RESERVATION)
    mockTimeSlotFindUnique.mockResolvedValue({ ...NEW_SLOT, maxCovers: 10, reservedCovers: 9 })

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

  it("runs changes inside a transaction", async () => {
    setupHappyPath()

    await modifyReservation({
      customerId: "cus_01",
      reservationId: "res_01",
      newTimeSlotId: "ts_02",
    })

    expect(mockTransaction).toHaveBeenCalledOnce()
  })
})
