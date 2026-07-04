// Tests for DayCloseService (NEW-011 — caixa / day-close reconciliation).
// Mock-based; no DB required.
//
// Scenarios:
// - aggregation math: orders + settled payments (pix/card/cash) + refunds →
//   correct gross / per-method settled / refunds / net
// - empty day → all zeroes
// - day-boundary correctness (Sao Paulo −03:00 + UTC) threaded to the query
// - settled-status filter uses paid/partially_refunded/refunded (never disputed)
// - malformed date → throws

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockOrderFindMany = vi.hoisted(() => vi.fn())
const mockPaymentFindMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    orderProjection: { findMany: mockOrderFindMany },
    payment: { findMany: mockPaymentFindMany },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createDayCloseService } from "../day-close.service.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function order(totalInCentavos: number) {
  return { totalInCentavos }
}

function payment(
  method: string,
  amountInCentavos: number,
  refundedAmountCentavos = 0,
) {
  return { method, amountInCentavos, refundedAmountCentavos }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DayCloseService.getDaySummary", () => {
  let svc: ReturnType<typeof createDayCloseService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createDayCloseService()
  })

  it("aggregates gross, per-method settled, refunds and net", async () => {
    mockOrderFindMany.mockResolvedValue([order(8900), order(5000), order(12000)])
    mockPaymentFindMany.mockResolvedValue([
      payment("pix", 8900),
      payment("card", 5000),
      payment("cash", 12000),
      payment("pix", 4000, 1500), // partial refund
      payment("card", 2000, 2000), // full refund
    ])

    const s = await svc.getDaySummary("2026-07-03", { timezone: "America/Sao_Paulo" })

    // Orders
    expect(s.orders.count).toBe(3)
    expect(s.orders.grossCentavos).toBe(25900)

    // Settled (captured) — pix 8900+4000, card 5000+2000, cash 12000
    expect(s.settled.count).toBe(5)
    expect(s.settled.byMethod).toEqual({ pix: 12900, card: 7000, cash: 12000 })
    expect(s.settled.totalCentavos).toBe(31900)
    // Top-line MUST equal the sum of the method buckets (every centavo bucketed).
    expect(s.settled.totalCentavos).toBe(
      s.settled.byMethod.pix + s.settled.byMethod.card + s.settled.byMethod.cash,
    )

    // Refunds — only the two refunded rows
    expect(s.refunds.count).toBe(2)
    expect(s.refunds.byMethod).toEqual({ pix: 1500, card: 2000, cash: 0 })
    expect(s.refunds.totalCentavos).toBe(3500)

    // Net = settled − refunds
    expect(s.netCentavos).toBe(28400)
  })

  it("returns zeroes for an empty day", async () => {
    mockOrderFindMany.mockResolvedValue([])
    mockPaymentFindMany.mockResolvedValue([])

    const s = await svc.getDaySummary("2026-07-03")

    expect(s.orders).toEqual({ count: 0, grossCentavos: 0 })
    expect(s.settled).toEqual({
      count: 0,
      totalCentavos: 0,
      byMethod: { pix: 0, card: 0, cash: 0 },
    })
    expect(s.refunds).toEqual({
      count: 0,
      totalCentavos: 0,
      byMethod: { pix: 0, card: 0, cash: 0 },
    })
    expect(s.netCentavos).toBe(0)
  })

  it("resolves the local-day window in America/Sao_Paulo (−03:00) and threads it to both queries", async () => {
    mockOrderFindMany.mockResolvedValue([])
    mockPaymentFindMany.mockResolvedValue([])

    const s = await svc.getDaySummary("2026-07-03", { timezone: "America/Sao_Paulo" })

    // Sao Paulo midnight 2026-07-03 == 03:00Z; next midnight == 2026-07-04 03:00Z.
    expect(s.windowStart).toBe("2026-07-03T03:00:00.000Z")
    expect(s.windowEnd).toBe("2026-07-04T03:00:00.000Z")

    const orderWhere = mockOrderFindMany.mock.calls[0][0].where
    expect(orderWhere.medusaCreatedAt.gte.toISOString()).toBe("2026-07-03T03:00:00.000Z")
    expect(orderWhere.medusaCreatedAt.lt.toISOString()).toBe("2026-07-04T03:00:00.000Z")

    // Payments are owner-joined to orders CREATED in the same window.
    const payWhere = mockPaymentFindMany.mock.calls[0][0].where
    expect(payWhere.order.medusaCreatedAt.gte.toISOString()).toBe("2026-07-03T03:00:00.000Z")
    expect(payWhere.order.medusaCreatedAt.lt.toISOString()).toBe("2026-07-04T03:00:00.000Z")
  })

  it("resolves the window in UTC when asked (boundary independent of host TZ)", async () => {
    mockOrderFindMany.mockResolvedValue([])
    mockPaymentFindMany.mockResolvedValue([])

    const s = await svc.getDaySummary("2026-07-03", { timezone: "UTC" })

    expect(s.windowStart).toBe("2026-07-03T00:00:00.000Z")
    expect(s.windowEnd).toBe("2026-07-04T00:00:00.000Z")
    expect(s.timezone).toBe("UTC")
  })

  it("filters payments to the captured set (paid / partially_refunded / refunded, never disputed)", async () => {
    mockOrderFindMany.mockResolvedValue([])
    mockPaymentFindMany.mockResolvedValue([])

    await svc.getDaySummary("2026-07-03", { timezone: "UTC" })

    const statusIn = mockPaymentFindMany.mock.calls[0][0].where.status.in as string[]
    expect(statusIn).toContain("paid")
    expect(statusIn).toContain("partially_refunded")
    expect(statusIn).toContain("refunded")
    expect(statusIn).not.toContain("disputed")
    expect(statusIn).not.toContain("payment_pending")
    expect(statusIn).not.toContain("canceled")
  })

  it("throws on a malformed date", async () => {
    await expect(svc.getDaySummary("03/07/2026")).rejects.toThrow(/YYYY-MM-DD/)
    expect(mockOrderFindMany).not.toHaveBeenCalled()
  })
})
