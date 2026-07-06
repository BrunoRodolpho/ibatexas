// Tests for LaborCostService (NEW-034 read-only labor-cost analytics). Mock-based;
// no DB required — the prisma.staffShift.findMany result is stubbed with joined
// Staff (name + hourlyRateCentavos), and the service does all aggregation.
//
// Scenarios:
// - empty range → empty byStaff + zero totals
// - scheduled-only (no clock stamps) → cost billed on SCHEDULED hours
// - both clock stamps → cost billed on ACTUAL hours (the fallback's ACTUAL branch)
// - per-staff MIX (one shift clocked, one not) → billable = actual + scheduled
// - null-rate staff → cost 0, rateMissing true, excluded from totalCost
// - deterministic centavo rounding (Math.round once, half-up)
// - window is resolved to Sao Paulo (−03:00) local-day boundaries
// - malformed date throws before any query

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockFindMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    staffShift: {
      findMany: mockFindMany,
    },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createLaborCostService } from "../labor-cost.service.js"

// ── Fixtures ────────────────────────────────────────────────────────────────

const D = (iso: string): Date => new Date(iso)

/** One raw shift row shaped like the service's `select` (joined Staff). */
function shift(opts: {
  staffId: string
  name: string
  rate: number | null
  startsAt: string
  endsAt: string
  actualStart?: string | null
  actualEnd?: string | null
}) {
  return {
    staffId: opts.staffId,
    startsAt: D(opts.startsAt),
    endsAt: D(opts.endsAt),
    actualStart: opts.actualStart ? D(opts.actualStart) : null,
    actualEnd: opts.actualEnd ? D(opts.actualEnd) : null,
    staff: { name: opts.name, hourlyRateCentavos: opts.rate },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("LaborCostService.getLaborCost", () => {
  let svc: ReturnType<typeof createLaborCostService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createLaborCostService()
  })

  it("returns empty byStaff + zero totals for an empty range", async () => {
    mockFindMany.mockResolvedValue([])

    const report = await svc.getLaborCost({
      from: "2026-07-04",
      to: "2026-07-06",
      timezone: "America/Sao_Paulo",
    })

    expect(report.byStaff).toEqual([])
    expect(report.totalCostCentavos).toBe(0)
    expect(report.totalScheduledHours).toBe(0)
    expect(report.totalActualHours).toBe(0)
    expect(report.range).toEqual({ from: "2026-07-04", to: "2026-07-06" })
    expect(report.timezone).toBe("America/Sao_Paulo")
  })

  it("resolves the [from, to) window to Sao Paulo local-day UTC boundaries", async () => {
    mockFindMany.mockResolvedValue([])

    await svc.getLaborCost({ from: "2026-07-04", to: "2026-07-06", timezone: "America/Sao_Paulo" })

    // Sao Paulo is a fixed −03:00 offset → local midnight is 03:00Z.
    const arg = mockFindMany.mock.calls[0]?.[0] as {
      where: { startsAt: { gte: Date; lt: Date } }
    }
    expect(arg.where.startsAt.gte.toISOString()).toBe("2026-07-04T03:00:00.000Z")
    expect(arg.where.startsAt.lt.toISOString()).toBe("2026-07-06T03:00:00.000Z")
  })

  it("bills SCHEDULED hours when a shift has no clock stamps", async () => {
    // 14:00→22:00 = 8h scheduled, no stamps, rate R$20,00 = 2000 centavos/h.
    mockFindMany.mockResolvedValue([
      shift({
        staffId: "staff_a",
        name: "Ana",
        rate: 2000,
        startsAt: "2026-07-04T14:00:00.000Z",
        endsAt: "2026-07-04T22:00:00.000Z",
      }),
    ])

    const report = await svc.getLaborCost({ from: "2026-07-04", to: "2026-07-05" })

    expect(report.byStaff).toEqual([
      {
        staffId: "staff_a",
        name: "Ana",
        scheduledHours: 8,
        actualHours: 0,
        costCentavos: 16000, // 8h × 2000
        rateMissing: false,
      },
    ])
    expect(report.totalCostCentavos).toBe(16000)
    expect(report.totalScheduledHours).toBe(8)
    expect(report.totalActualHours).toBe(0)
  })

  it("bills ACTUAL hours when BOTH clock stamps are present (fallback ACTUAL branch)", async () => {
    // Scheduled 8h but clocked 7.5h (14:30→22:00). rate 2000 → cost on ACTUAL.
    mockFindMany.mockResolvedValue([
      shift({
        staffId: "staff_a",
        name: "Ana",
        rate: 2000,
        startsAt: "2026-07-04T14:00:00.000Z",
        endsAt: "2026-07-04T22:00:00.000Z",
        actualStart: "2026-07-04T14:30:00.000Z",
        actualEnd: "2026-07-04T22:00:00.000Z",
      }),
    ])

    const report = await svc.getLaborCost({ from: "2026-07-04", to: "2026-07-05" })

    expect(report.byStaff[0]).toMatchObject({
      scheduledHours: 8,
      actualHours: 7.5,
      costCentavos: 15000, // 7.5h × 2000 (ACTUAL, not scheduled 16000)
      rateMissing: false,
    })
    expect(report.totalActualHours).toBe(7.5)
  })

  it("bills a PER-SHIFT MIX: actual for clocked shifts, scheduled for un-clocked", async () => {
    // Shift 1: clocked 4h (both stamps). Shift 2: scheduled 5h, no stamps.
    // billable = 4 (actual) + 5 (scheduled) = 9h; rate 1500 → 13500.
    mockFindMany.mockResolvedValue([
      shift({
        staffId: "staff_c",
        name: "Caio",
        rate: 1500,
        startsAt: "2026-07-04T08:00:00.000Z",
        endsAt: "2026-07-04T12:00:00.000Z",
        actualStart: "2026-07-04T08:00:00.000Z",
        actualEnd: "2026-07-04T12:00:00.000Z",
      }),
      shift({
        staffId: "staff_c",
        name: "Caio",
        rate: 1500,
        startsAt: "2026-07-04T13:00:00.000Z",
        endsAt: "2026-07-04T18:00:00.000Z",
      }),
    ])

    const report = await svc.getLaborCost({ from: "2026-07-04", to: "2026-07-05" })

    expect(report.byStaff).toHaveLength(1)
    expect(report.byStaff[0]).toMatchObject({
      staffId: "staff_c",
      scheduledHours: 9, // 4 + 5
      actualHours: 4, // only the clocked shift
      costCentavos: 13500, // (4 + 5) × 1500
      rateMissing: false,
    })
  })

  it("excludes a NULL-rate staff from cost but still reports their hours", async () => {
    mockFindMany.mockResolvedValue([
      shift({
        staffId: "staff_b",
        name: "Bia",
        rate: null,
        startsAt: "2026-07-04T14:00:00.000Z",
        endsAt: "2026-07-04T20:00:00.000Z", // 6h
      }),
    ])

    const report = await svc.getLaborCost({ from: "2026-07-04", to: "2026-07-05" })

    expect(report.byStaff[0]).toEqual({
      staffId: "staff_b",
      name: "Bia",
      scheduledHours: 6,
      actualHours: 0,
      costCentavos: 0, // rate unknown → NEVER guessed
      rateMissing: true,
    })
    expect(report.totalCostCentavos).toBe(0) // null-rate contributes 0
    expect(report.totalScheduledHours).toBe(6)
  })

  it("rounds cost deterministically (Math.round once, half-up)", async () => {
    // 90 min scheduled = 1.5h, rate 999 → 1.5 × 999 = 1498.5 → rounds to 1499.
    mockFindMany.mockResolvedValue([
      shift({
        staffId: "staff_r",
        name: "Rui",
        rate: 999,
        startsAt: "2026-07-04T09:00:00.000Z",
        endsAt: "2026-07-04T10:30:00.000Z",
      }),
    ])

    const report = await svc.getLaborCost({ from: "2026-07-04", to: "2026-07-05" })

    expect(report.byStaff[0]?.scheduledHours).toBe(1.5)
    expect(report.byStaff[0]?.costCentavos).toBe(1499)
  })

  it("aggregates multiple staff, ordering byStaff and summing totals", async () => {
    mockFindMany.mockResolvedValue([
      // a: clocked 7.5h of 8h scheduled, rate 2000 → 15000
      shift({
        staffId: "staff_a",
        name: "Ana",
        rate: 2000,
        startsAt: "2026-07-04T14:00:00.000Z",
        endsAt: "2026-07-04T22:00:00.000Z",
        actualStart: "2026-07-04T14:30:00.000Z",
        actualEnd: "2026-07-04T22:00:00.000Z",
      }),
      // b: null rate, 6h scheduled → 0
      shift({
        staffId: "staff_b",
        name: "Bia",
        rate: null,
        startsAt: "2026-07-04T14:00:00.000Z",
        endsAt: "2026-07-04T20:00:00.000Z",
      }),
      // c: mix — clocked 4h + scheduled 5h, rate 1500 → 13500
      shift({
        staffId: "staff_c",
        name: "Caio",
        rate: 1500,
        startsAt: "2026-07-04T08:00:00.000Z",
        endsAt: "2026-07-04T12:00:00.000Z",
        actualStart: "2026-07-04T08:00:00.000Z",
        actualEnd: "2026-07-04T12:00:00.000Z",
      }),
      shift({
        staffId: "staff_c",
        name: "Caio",
        rate: 1500,
        startsAt: "2026-07-04T13:00:00.000Z",
        endsAt: "2026-07-04T18:00:00.000Z",
      }),
    ])

    const report = await svc.getLaborCost({ from: "2026-07-04", to: "2026-07-05" })

    expect(report.byStaff.map((s) => s.staffId)).toEqual(["staff_a", "staff_b", "staff_c"])
    expect(report.byStaff.map((s) => s.costCentavos)).toEqual([15000, 0, 13500])
    expect(report.totalCostCentavos).toBe(28500) // 15000 + 0 + 13500
    expect(report.totalScheduledHours).toBe(23) // 8 + 6 + 9
    expect(report.totalActualHours).toBe(11.5) // 7.5 + 0 + 4
  })

  it("throws on a malformed date before querying", async () => {
    await expect(
      svc.getLaborCost({ from: "2026-7-4", to: "2026-07-05" }),
    ).rejects.toThrow(/YYYY-MM-DD/)
    expect(mockFindMany).not.toHaveBeenCalled()
  })
})
