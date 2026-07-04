// Tests for StaffScheduleService (NEW-016 escala core — assign + list-by-range +
// delete). Mock-based; no DB required.
//
// Scenarios:
// - createShift: threads staffId/startsAt/endsAt + null-coalesced role/note
// - listShifts: resolves the [from, to) window to Sao Paulo (−03:00) local-day
//   boundaries; threads the optional staffId filter; malformed date → throws
// - deleteShift: returns the deleted row; returns null (no throw) when missing

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockCreate = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())
const mockFindUnique = vi.hoisted(() => vi.fn())
const mockDeleteMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    staffShift: {
      create: mockCreate,
      findMany: mockFindMany,
      findUnique: mockFindUnique,
      deleteMany: mockDeleteMany,
    },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createStaffScheduleService } from "../staff-schedule.service.js"

// ── Tests ───────────────────────────────────────────────────────────────────

describe("StaffScheduleService.createShift", () => {
  let svc: ReturnType<typeof createStaffScheduleService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createStaffScheduleService()
  })

  it("assigns a shift, threading fields and null-coalescing optional role/note", async () => {
    const startsAt = new Date("2026-07-04T14:00:00.000Z")
    const endsAt = new Date("2026-07-04T22:00:00.000Z")
    mockCreate.mockResolvedValue({ id: "shift_1", staffId: "staff_1", startsAt, endsAt })

    const row = await svc.createShift({ staffId: "staff_1", startsAt, endsAt, role: "COZINHA" })

    expect(row).toMatchObject({ id: "shift_1" })
    expect(mockCreate).toHaveBeenCalledWith({
      data: { staffId: "staff_1", startsAt, endsAt, role: "COZINHA", note: null },
    })
  })

  it("defaults role and note to null when omitted", async () => {
    const startsAt = new Date("2026-07-04T14:00:00.000Z")
    const endsAt = new Date("2026-07-04T22:00:00.000Z")
    mockCreate.mockResolvedValue({ id: "shift_2" })

    await svc.createShift({ staffId: "staff_2", startsAt, endsAt })

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { role: null, note: null },
    })
  })
})

describe("StaffScheduleService.listShifts", () => {
  let svc: ReturnType<typeof createStaffScheduleService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createStaffScheduleService()
  })

  it("resolves the [from, to) window to Sao Paulo local-day UTC boundaries", async () => {
    mockFindMany.mockResolvedValue([{ id: "shift_1" }])

    const rows = await svc.listShifts({
      from: "2026-07-04",
      to: "2026-07-06",
      timezone: "America/Sao_Paulo",
    })

    expect(rows.map((r: { id: string }) => r.id)).toEqual(["shift_1"])
    // Sao Paulo is a fixed −03:00 offset → local midnight is 03:00Z.
    const arg = mockFindMany.mock.calls[0]?.[0] as {
      where: { startsAt: { gte: Date; lt: Date }; staffId?: string }
    }
    expect(arg.where.startsAt.gte.toISOString()).toBe("2026-07-04T03:00:00.000Z")
    expect(arg.where.startsAt.lt.toISOString()).toBe("2026-07-06T03:00:00.000Z")
    // No staffId filter when omitted.
    expect(arg.where.staffId).toBeUndefined()
  })

  it("threads the optional staffId filter", async () => {
    mockFindMany.mockResolvedValue([])

    await svc.listShifts({
      from: "2026-07-04",
      to: "2026-07-05",
      staffId: "staff_9",
      timezone: "America/Sao_Paulo",
    })

    const arg = mockFindMany.mock.calls[0]?.[0] as { where: { staffId?: string } }
    expect(arg.where.staffId).toBe("staff_9")
  })

  it("throws on a malformed date", async () => {
    await expect(
      svc.listShifts({ from: "2026-7-4", to: "2026-07-05" }),
    ).rejects.toThrow(/YYYY-MM-DD/)
    expect(mockFindMany).not.toHaveBeenCalled()
  })
})

describe("StaffScheduleService.deleteShift", () => {
  let svc: ReturnType<typeof createStaffScheduleService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createStaffScheduleService()
  })

  it("deletes an existing shift and returns the row", async () => {
    mockFindUnique.mockResolvedValue({ id: "shift_1", staffId: "staff_1" })
    mockDeleteMany.mockResolvedValue({ count: 1 })

    const row = await svc.deleteShift("shift_1")

    expect(row).toMatchObject({ id: "shift_1" })
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "shift_1" } })
  })

  it("returns null (no throw, no delete) when the id does not exist", async () => {
    mockFindUnique.mockResolvedValue(null)

    const row = await svc.deleteShift("missing")

    expect(row).toBeNull()
    expect(mockDeleteMany).not.toHaveBeenCalled()
  })
})
