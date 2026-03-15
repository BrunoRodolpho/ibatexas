// Tests for check_table_availability tool
// Mock-based; no database required.
//
// Scenarios:
// - Happy path: returns available slots for a date
// - Slot with insufficient covers is excluded
// - preferredTime filter excludes non-matching slots
// - No time slots for date → empty array + pt-BR message

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockTimeSlotFindMany = vi.hoisted(() => vi.fn())
const mockReservationTableFindMany = vi.hoisted(() => vi.fn())
const mockTableFindMany = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    timeSlot: { findMany: mockTimeSlotFindMany },
    reservationTable: { findMany: mockReservationTableFindMany },
    table: { findMany: mockTableFindMany },
  },
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { checkTableAvailability } from "../check-availability.js"

// ── Fixtures ───────────────────────────────────────────────────────────────────

const DATE = "2026-03-15"

function makeSlot(overrides: Partial<{
  id: string; startTime: string; durationMinutes: number; maxCovers: number; reservedCovers: number
}> = {}) {
  return {
    id: overrides.id ?? "ts_01",
    date: new Date(`${DATE}T00:00:00.000Z`),
    startTime: overrides.startTime ?? "19:30",
    durationMinutes: overrides.durationMinutes ?? 90,
    maxCovers: overrides.maxCovers ?? 40,
    reservedCovers: overrides.reservedCovers ?? 0,
    createdAt: new Date(),
  }
}

const FREE_TABLES = [
  { location: "indoor" },
  { location: "outdoor" },
]

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("checkTableAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReservationTableFindMany.mockResolvedValue([])
    mockTableFindMany.mockResolvedValue(FREE_TABLES)
  })

  it("returns available slots when capacity exists", async () => {
    mockTimeSlotFindMany.mockResolvedValue([
      makeSlot({ id: "ts_lunch", startTime: "12:00", maxCovers: 40, reservedCovers: 0 }),
      makeSlot({ id: "ts_dinner", startTime: "19:30", maxCovers: 40, reservedCovers: 10 }),
    ])

    const result = await checkTableAvailability({ date: DATE, partySize: 4 })

    expect(result.slots).toHaveLength(2)
    expect(result.slots[0].startTime).toBe("12:00")
    expect(result.slots[0].availableCovers).toBe(40)
    expect(result.slots[1].availableCovers).toBe(30)
    expect(result.slots[0].tableLocations).toContain("indoor")
    expect(result.message).toContain("2 horário(s)")
  })

  it("excludes slots where reservedCovers + partySize > maxCovers", async () => {
    mockTimeSlotFindMany.mockResolvedValue([
      makeSlot({ id: "ts_full", startTime: "20:00", maxCovers: 20, reservedCovers: 18 }),
      makeSlot({ id: "ts_ok", startTime: "21:00", maxCovers: 40, reservedCovers: 0 }),
    ])

    const result = await checkTableAvailability({ date: DATE, partySize: 4 })

    expect(result.slots).toHaveLength(1)
    expect(result.slots[0].timeSlotId).toBe("ts_ok")
  })

  it("filters by preferredTime when provided", async () => {
    mockTimeSlotFindMany.mockResolvedValue([
      makeSlot({ id: "ts_lunch", startTime: "12:00" }),
      makeSlot({ id: "ts_dinner", startTime: "19:30" }),
    ])

    const result = await checkTableAvailability({
      date: DATE,
      partySize: 2,
      preferredTime: "19:30",
    })

    expect(result.slots).toHaveLength(1)
    expect(result.slots[0].startTime).toBe("19:30")
  })

  it("returns empty list with pt-BR message when no slots exist for date", async () => {
    mockTimeSlotFindMany.mockResolvedValue([])

    const result = await checkTableAvailability({ date: DATE, partySize: 2 })

    expect(result.slots).toHaveLength(0)
    expect(result.message).toContain(DATE)
  })

  it("returns empty list with pt-BR message when all slots are full", async () => {
    mockTimeSlotFindMany.mockResolvedValue([
      makeSlot({ maxCovers: 10, reservedCovers: 10 }),
    ])

    const result = await checkTableAvailability({ date: DATE, partySize: 2 })

    expect(result.slots).toHaveLength(0)
    expect(result.message).toContain("Não encontrei")
  })

  it("excludes reserved table ids from free-table query", async () => {
    mockTimeSlotFindMany.mockResolvedValue([
      makeSlot({ id: "ts_01", maxCovers: 40, reservedCovers: 0 }),
    ])
    mockReservationTableFindMany.mockResolvedValue([{ tableId: "tbl_01" }])

    await checkTableAvailability({ date: DATE, partySize: 4 })

    expect(mockTableFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: expect.objectContaining({ notIn: ["tbl_01"] }),
        }),
      }),
    )
  })
})
