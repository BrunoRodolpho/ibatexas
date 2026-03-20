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
  createReservationService: () => ({
    getById: async (id: string, customerId?: string) => {
      const reservation = await mockReservationFindUnique({ where: { id }, include: { timeSlot: true, tables: { include: { table: true } } } })
      if (!reservation) throw new Error("Reserva não encontrada.")
      if (customerId && reservation.customerId !== customerId) throw new Error("Você não tem permissão para acessar esta reserva.")
      const ts = reservation.timeSlot
      return {
        id: reservation.id, customerId: reservation.customerId, partySize: reservation.partySize,
        status: reservation.status, specialRequests: reservation.specialRequests ?? [],
        timeSlot: { id: ts.id, date: ts.date.toISOString().split("T")[0] ?? "", startTime: ts.startTime, durationMinutes: ts.durationMinutes },
        tableLocation: null, confirmedAt: null, checkedInAt: null, cancelledAt: null,
        createdAt: reservation.createdAt.toISOString(), updatedAt: reservation.updatedAt.toISOString(),
      }
    },
    cancel: async (id: string, customerId: string) => {
      const reservation = await mockReservationFindUnique({ where: { id }, include: { timeSlot: true } })
      if (!reservation) throw new Error("Reserva não encontrada.")
      if (reservation.customerId !== customerId) throw new Error("Você não tem permissão para cancelar esta reserva.")
      if (["cancelled", "no_show", "completed"].includes(reservation.status)) throw new Error(`Não é possível cancelar reserva com status "${reservation.status}".`)
      await mockTransaction([
        mockReservationUpdate({ where: { id }, data: { status: "cancelled", cancelledAt: new Date() } }),
        mockReservationTableDeleteMany({ where: { reservationId: id } }),
        mockTimeSlotUpdate({ where: { id: reservation.timeSlotId }, data: { reservedCovers: { decrement: reservation.partySize } } }),
      ])
      return { timeSlotId: reservation.timeSlotId, partySize: reservation.partySize }
    },
    promoteWaitlist: async (timeSlotId: string) => {
      const next = await mockWaitlistFindFirst({ where: { timeSlotId, notifiedAt: null }, orderBy: { createdAt: "asc" } })
      if (!next) return { promoted: null }
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
      await mockWaitlistUpdate({ where: { id: next.id }, data: { notifiedAt: new Date(), expiresAt } })
      return {
        promoted: {
          id: next.id, customerId: next.customerId, partySize: next.partySize,
          date: "", startTime: "",
        },
      }
    },
  }),
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
  sendReservationCancelled: vi.fn().mockResolvedValue(undefined),
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

  it("throws 'não encontrada' when reservation not found (SEC-002 guard)", async () => {
    mockReservationFindUnique.mockResolvedValue(null)

    await expect(
      cancelReservation({ customerId: "cus_01", reservationId: "res_99" }),
    ).rejects.toThrow("não encontrada")
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
  })

  it("throws 'Acesso negado' for wrong owner (SEC-002 guard)", async () => {
    mockReservationFindUnique.mockResolvedValue(RESERVATION)

    await expect(
      cancelReservation({ customerId: "cus_WRONG", reservationId: "res_01" }),
    ).rejects.toThrow("Acesso negado")
    expect(mockReservationUpdate).not.toHaveBeenCalled()
  })

  it("returns success:false if already cancelled", async () => {
    mockReservationFindUnique.mockResolvedValue({ ...RESERVATION, status: "cancelled" })

    const result = await cancelReservation({ customerId: "cus_01", reservationId: "res_01" })

    expect(result.success).toBe(false)
    expect(result.message).toContain("cancelled")
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
