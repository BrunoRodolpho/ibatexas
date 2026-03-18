// Tests for get_my_reservations tool
// Mock-based; no database required.
//
// Scenarios:
// - Returns empty list when customer has no reservations
// - Returns mapped DTOs + total count
// - Status filter is forwarded to Prisma query
// - Limit is respected

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockReservationFindMany = vi.hoisted(() => vi.fn())
const mockReservationCount = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: {
      findMany: mockReservationFindMany,
      count: mockReservationCount,
    },
  },
  createReservationService: () => ({
    listByCustomer: async (
      customerId: string,
      options?: { status?: string; limit?: number },
    ) => {
      const where: Record<string, unknown> = { customerId }
      if (options?.status) where.status = options.status
      const [reservations, total] = await Promise.all([
        mockReservationFindMany({
          where,
          include: { timeSlot: true, tables: { include: { table: true } } },
          orderBy: [{ timeSlot: { date: "desc" } }, { timeSlot: { startTime: "desc" } }],
          take: options?.limit ?? 10,
        }),
        mockReservationCount({ where }),
      ])
      return {
        reservations: (reservations as Array<Record<string, unknown>>).map((r: Record<string, unknown>) => ({ ...r, _mapped: true })),
        total,
      }
    },
  }),
}))

// reservationToDTO is tested via integration; mock it for unit isolation
vi.mock("../utils.js", () => ({
  reservationToDTO: vi.fn((r: { id: string }) => ({ ...r, _mapped: true })),
  assignTables: vi.fn(),
  releaseReservation: vi.fn(),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { getMyReservations } from "../get-my-reservations.js"
import { ReservationStatus } from "@ibatexas/types"

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeRow(id: string) {
  return {
    id,
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
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("getMyReservations", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("returns empty list when customer has no reservations", async () => {
    mockReservationFindMany.mockResolvedValue([])
    mockReservationCount.mockResolvedValue(0)

    const result = await getMyReservations({ customerId: "cus_01", limit: 10 })

    expect(result.reservations).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it("returns mapped DTOs for all reservations", async () => {
    const rows = [makeRow("res_01"), makeRow("res_02")]
    mockReservationFindMany.mockResolvedValue(rows)
    mockReservationCount.mockResolvedValue(2)

    const result = await getMyReservations({ customerId: "cus_01", limit: 10 })

    expect(result.reservations).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it("forwards customerId filter to prisma query", async () => {
    mockReservationFindMany.mockResolvedValue([])
    mockReservationCount.mockResolvedValue(0)

    await getMyReservations({ customerId: "cus_42", limit: 10 })

    expect(mockReservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerId: "cus_42" }),
      }),
    )
  })

  it("includes status filter when provided", async () => {
    mockReservationFindMany.mockResolvedValue([])
    mockReservationCount.mockResolvedValue(0)

    await getMyReservations({ customerId: "cus_01", status: ReservationStatus.CONFIRMED, limit: 10 })

    expect(mockReservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: ReservationStatus.CONFIRMED }),
      }),
    )
  })

  it("respects the limit option", async () => {
    mockReservationFindMany.mockResolvedValue([])
    mockReservationCount.mockResolvedValue(0)

    await getMyReservations({ customerId: "cus_01", limit: 5 })

    expect(mockReservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    )
  })
})
