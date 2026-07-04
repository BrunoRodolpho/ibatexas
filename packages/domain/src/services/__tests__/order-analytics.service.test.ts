// Tests for OrderAnalyticsService (NEW-013 slice — top-items + refund analytics).
// Mock-based; no DB required.
//
// Scenarios:
// - top-items: quantity / orderCount (distinct orders) / grossCentavos aggregation,
//   desc-by-quantity ordering, limit cap, empty range
// - refunds: total + count + per-day trend (bucketed by the order's local day),
//   captured-status + refundedAmountCentavos>0 filter, empty range
// - range window correctness (Sao Paulo −03:00) threaded to the queries
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

import { createOrderAnalyticsService } from "../order-analytics.service.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function item(productId: string, title: string, quantity: number, priceInCentavos: number) {
  return { productId, variantId: `${productId}-v`, title, quantity, priceInCentavos }
}

/** An order projection row as returned by the top-items query (itemsJson only). */
function orderWith(...items: ReturnType<typeof item>[]) {
  return { itemsJson: items }
}

/** A refunded payment row as returned by the refunds query. */
function refundPayment(refundedAmountCentavos: number, medusaCreatedAt: string) {
  return { refundedAmountCentavos, order: { medusaCreatedAt: new Date(medusaCreatedAt) } }
}

const RANGE = { from: "2026-07-01", to: "2026-07-08" }

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OrderAnalyticsService.getTopItems", () => {
  let svc: ReturnType<typeof createOrderAnalyticsService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createOrderAnalyticsService()
  })

  it("aggregates quantity, distinct orderCount and grossCentavos, sorted desc by quantity", async () => {
    mockOrderFindMany.mockResolvedValue([
      // Order 1: picanha x2 (8900), pao x1 (500)
      orderWith(item("prod_picanha", "Picanha", 2, 8900), item("prod_pao", "Pão de alho", 1, 500)),
      // Order 2: picanha x1 (8900), picanha again as a second line x1 (same product, diff variant)
      orderWith(item("prod_picanha", "Picanha", 1, 8900), item("prod_picanha", "Picanha", 1, 8900)),
      // Order 3: refri x3 (700)
      orderWith(item("prod_refri", "Refrigerante", 3, 700)),
    ])

    const rows = await svc.getTopItems(RANGE, { timezone: "America/Sao_Paulo" })

    // picanha: qty 2+1+1 = 4, present in orders 1 & 2 → orderCount 2, gross 4*8900 = 35600
    // refri:   qty 3,       one order → orderCount 1, gross 2100
    // pao:     qty 1,       one order → orderCount 1, gross 500
    expect(rows.map((r) => r.productId)).toEqual(["prod_picanha", "prod_refri", "prod_pao"])

    const picanha = rows[0]
    expect(picanha).toEqual({
      productId: "prod_picanha",
      title: "Picanha",
      quantity: 4,
      orderCount: 2,
      grossCentavos: 35600,
    })
    expect(rows[1]).toMatchObject({ productId: "prod_refri", quantity: 3, orderCount: 1, grossCentavos: 2100 })
    expect(rows[2]).toMatchObject({ productId: "prod_pao", quantity: 1, orderCount: 1, grossCentavos: 500 })
  })

  it("caps the result at the requested limit", async () => {
    mockOrderFindMany.mockResolvedValue([
      orderWith(
        item("a", "A", 5, 100),
        item("b", "B", 4, 100),
        item("c", "C", 3, 100),
        item("d", "D", 2, 100),
      ),
    ])

    const rows = await svc.getTopItems(RANGE, { limit: 2 })
    expect(rows.map((r) => r.productId)).toEqual(["a", "b"])
  })

  it("defaults the limit to 10", async () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      item(`p${String(i).padStart(2, "0")}`, `P${i}`, 15 - i, 100),
    )
    mockOrderFindMany.mockResolvedValue([orderWith(...many)])

    const rows = await svc.getTopItems(RANGE)
    expect(rows).toHaveLength(10)
    expect(rows[0].productId).toBe("p00") // highest quantity
  })

  it("returns an empty array for an empty range", async () => {
    mockOrderFindMany.mockResolvedValue([])
    const rows = await svc.getTopItems(RANGE)
    expect(rows).toEqual([])
  })

  it("skips line items with no product id and tolerates a non-array itemsJson", async () => {
    mockOrderFindMany.mockResolvedValue([
      orderWith(item("", "No product", 9, 100), item("prod_x", "X", 1, 200)),
      { itemsJson: null },
    ])
    const rows = await svc.getTopItems(RANGE)
    expect(rows).toEqual([
      { productId: "prod_x", title: "X", quantity: 1, orderCount: 1, grossCentavos: 200 },
    ])
  })

  it("resolves the [from,to) window in America/Sao_Paulo (−03:00) and threads it to the query", async () => {
    mockOrderFindMany.mockResolvedValue([])
    await svc.getTopItems(RANGE, { timezone: "America/Sao_Paulo" })

    const where = mockOrderFindMany.mock.calls[0][0].where
    // Sao Paulo midnight 2026-07-01 == 03:00Z; exclusive end at 2026-07-08 03:00Z.
    expect(where.medusaCreatedAt.gte.toISOString()).toBe("2026-07-01T03:00:00.000Z")
    expect(where.medusaCreatedAt.lt.toISOString()).toBe("2026-07-08T03:00:00.000Z")
  })

  it("throws on a malformed range date", async () => {
    await expect(svc.getTopItems({ from: "01/07/2026", to: "2026-07-08" })).rejects.toThrow(/YYYY-MM-DD/)
    expect(mockOrderFindMany).not.toHaveBeenCalled()
  })
})

describe("OrderAnalyticsService.getRefundAnalytics", () => {
  let svc: ReturnType<typeof createOrderAnalyticsService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createOrderAnalyticsService()
  })

  it("aggregates total refunded, refund count and a per-day trend", async () => {
    mockPaymentFindMany.mockResolvedValue([
      refundPayment(1500, "2026-07-01T14:00:00.000Z"),
      refundPayment(2000, "2026-07-01T18:00:00.000Z"),
      refundPayment(5000, "2026-07-03T12:00:00.000Z"),
    ])

    const r = await svc.getRefundAnalytics(RANGE, { timezone: "America/Sao_Paulo" })

    expect(r.totalRefundedCentavos).toBe(8500)
    expect(r.refundCount).toBe(3)
    // 2026-07-01 has two refunds (1500 + 2000); 2026-07-03 has one (5000).
    expect(r.trend).toEqual([
      { date: "2026-07-01", refundedCentavos: 3500, count: 2 },
      { date: "2026-07-03", refundedCentavos: 5000, count: 1 },
    ])
    // Trend total reconciles with the top-line total.
    expect(r.trend.reduce((s, p) => s + p.refundedCentavos, 0)).toBe(r.totalRefundedCentavos)
    expect(r.range).toEqual(RANGE)
  })

  it("buckets by the LOCAL day (an order at 01:00Z on Jul-02 is Jul-01 in −03:00)", async () => {
    // 2026-07-02T01:00Z is 2026-07-01 22:00 in Sao Paulo → bucketed under Jul-01.
    mockPaymentFindMany.mockResolvedValue([refundPayment(1000, "2026-07-02T01:00:00.000Z")])
    const r = await svc.getRefundAnalytics(RANGE, { timezone: "America/Sao_Paulo" })
    expect(r.trend).toEqual([{ date: "2026-07-01", refundedCentavos: 1000, count: 1 }])
  })

  it("returns zeroes and an empty trend for an empty range", async () => {
    mockPaymentFindMany.mockResolvedValue([])
    const r = await svc.getRefundAnalytics(RANGE)
    expect(r.totalRefundedCentavos).toBe(0)
    expect(r.refundCount).toBe(0)
    expect(r.trend).toEqual([])
  })

  it("resolves the window and filters to the captured set with refundedAmountCentavos>0", async () => {
    mockPaymentFindMany.mockResolvedValue([])
    const r = await svc.getRefundAnalytics(RANGE, { timezone: "America/Sao_Paulo" })

    expect(r.windowStart).toBe("2026-07-01T03:00:00.000Z")
    expect(r.windowEnd).toBe("2026-07-08T03:00:00.000Z")

    const where = mockPaymentFindMany.mock.calls[0][0].where
    // Owner-joined to orders created in the same window.
    expect(where.order.medusaCreatedAt.gte.toISOString()).toBe("2026-07-01T03:00:00.000Z")
    expect(where.order.medusaCreatedAt.lt.toISOString()).toBe("2026-07-08T03:00:00.000Z")
    // Captured-status set (never disputed) + only rows carrying a refund.
    const statusIn = where.status.in as string[]
    expect(statusIn).toContain("paid")
    expect(statusIn).toContain("partially_refunded")
    expect(statusIn).toContain("refunded")
    expect(statusIn).not.toContain("disputed")
    expect(where.refundedAmountCentavos).toEqual({ gt: 0 })
  })

  it("throws on a malformed range date", async () => {
    await expect(svc.getRefundAnalytics({ from: "2026-07-01", to: "08-07-2026" })).rejects.toThrow(
      /YYYY-MM-DD/,
    )
    expect(mockPaymentFindMany).not.toHaveBeenCalled()
  })
})
