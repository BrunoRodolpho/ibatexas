// Tests for cancel_reservation tool
// Mock-based; no database required.
//
// Scenarios:
// - Not found → {success: false}
// - Wrong owner → {success: false}
// - Already cancelled/completed/no_show → {success: false}
// - Happy path → {success: true}, NATS published
// - Next waitlist entry is notified on cancellation

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockReservationFindUnique = vi.hoisted(() => vi.fn())
const mockReservationUpdate = vi.hoisted(() => vi.fn())
const mockReservationTableDeleteMany = vi.hoisted(() => vi.fn())
const mockTimeSlotUpdate = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
const mockWaitlistFindFirst = vi.hoisted(() => vi.fn())
const mockWaitlistUpdate = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockReleaseReservation = vi.hoisted(() => vi.fn())
const mockNotifyWaitlistSpotAvailable = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: {
      findUnique: mockReservationFindUnique,
      update: mockReservationUpdate,
    },
    reservationTable: {
      deleteMany: mockReservationTableDeleteMany,
    },
    timeSlot: {
      update: mockTimeSlotUpdate,
    },
    waitlist: {
      findFirst: mockWaitlistFindFirst,
      update: mockWaitlistUpdate,
    },
    $transaction: mockTransaction,
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

vi.mock("../utils.js", () => ({
  releaseReservation: mockReleaseReservation,
  reservationToDTO: vi.fn(),
  assignTables: vi.fn(),
}))

vi.mock("../notifications.js", () => ({
  notifyWaitlistSpotAvailable: mockNotifyWaitlistSpotAvailable,
  sendReservationConfirmation: vi.fn(),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { cancelReservation } from "../cancel-reservation.js"

// ── Fixtures ───────────────────────────────────────────────────────────────────

const RESERVATION = {
  id: "res_01",
  customerId: "cus_01",
  partySize: 4,
  status: "confirmed",
  timeSlotId: "ts_01",
  timeSlot: {
    id: "ts_01",
    date: new Date("2026-03-15T00:00:00.000Z"),
    startTime: "19:30",
    durationMinutes: 90,
  },
  confirmedAt: new Date(),
  checkedInAt: null,
  cancelledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("cancelReservation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockReleaseReservation.mockResolvedValue(undefined)
    mockNotifyWaitlistSpotAvailable.mockResolvedValue(undefined)
    mockReservationUpdate.mockResolvedValue({ ...RESERVATION, status: "cancelled" })
    mockTransaction.mockResolvedValue(undefined)
    mockWaitlistFindFirst.mockResolvedValue(null) // no waitlist by default
    mockWaitlistUpdate.mockResolvedValue(undefined)
  })

  it("returns success:false when reservation not found", async () => {
    mockReservationFindUnique.mockResolvedValue(null)

    const result = await cancelReservation({ customerId: "cus_01", reservationId: "res_99" })

    expect(result.success).toBe(false)
    expect(result.message).toContain("não encontrada")
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
  })

  it("returns success:false for wrong owner", async () => {
    mockReservationFindUnique.mockResolvedValue(RESERVATION)

    const result = await cancelReservation({ customerId: "cus_WRONG", reservationId: "res_01" })

    expect(result.success).toBe(false)
    expect(result.message).toContain("permissão")
    expect(mockReservationUpdate).not.toHaveBeenCalled()
  })

  it("returns success:false if already cancelled", async () => {
    mockReservationFindUnique.mockResolvedValue({ ...RESERVATION, status: "cancelled" })

    const result = await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(result.success).toBe(false)
    expect(result.message).toContain("cancelada")
  })

  it("returns success:false if completed", async () => {
    mockReservationFindUnique.mockResolvedValue({ ...RESERVATION, status: "completed" })

    const result = await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(result.success).toBe(false)
  })

  it("returns success:true and publishes NATS event on happy path", async () => {
    mockReservationFindUnique.mockResolvedValue(RESERVATION)

    const result = await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(result.success).toBe(true)
    expect(mockTransaction).toHaveBeenCalledOnce()
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "reservation.cancelled",
      expect.objectContaining({
        customerId: "cus_01",
        metadata: expect.objectContaining({ reservationId: "res_01" }),
      }),
    )
  })

  it("notifies next waitlist entry if one exists", async () => {
    mockReservationFindUnique.mockResolvedValue(RESERVATION)
    mockWaitlistFindFirst.mockResolvedValue({
      id: "wl_01",
      customerId: "cus_02",
      timeSlotId: "ts_01",
      partySize: 2,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      notifiedAt: null,
    })

    await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(mockWaitlistUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "wl_01" } }),
    )
    expect(mockNotifyWaitlistSpotAvailable).toHaveBeenCalledOnce()
  })

  it("does not call notifyWaitlistSpotAvailable when no one is waiting", async () => {
    mockReservationFindUnique.mockResolvedValue(RESERVATION)
    mockWaitlistFindFirst.mockResolvedValue(null)

    await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(mockNotifyWaitlistSpotAvailable).not.toHaveBeenCalled()
  })
})
