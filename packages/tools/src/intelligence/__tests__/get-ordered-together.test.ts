// Tests for get_ordered_together tool
// Mock-based; no database required.
//
// Scenarios:
// - Guest: returns empty (no customerId)
// - No orders containing the product: returns empty
// - Happy path: co-items ranked by frequency
// - No co-items in those orders: returns empty
// - orderCount mapping from groupBy

import { describe, it, expect, beforeEach, vi } from "vitest"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockOrderItemFindMany = vi.hoisted(() => vi.fn())
const mockOrderItemGroupBy = vi.hoisted(() => vi.fn())
const mockQueryProductsByIds = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    customerOrderItem: {
      findMany: mockOrderItemFindMany,
      groupBy: mockOrderItemGroupBy,
    },
  },
}))

vi.mock("../query-products-by-ids.js", () => ({
  queryProductsByIds: mockQueryProductsByIds,
}))

// -- Imports ──────────────────────────────────────────────────────────────────

import { getOrderedTogether } from "../get-ordered-together.js"

// -- Fixtures ─────────────────────────────────────────────────────────────────

const CTX_AUTH = {
  customerId: "cus_01",
  channel: "whatsapp" as const,
  sessionId: "sess_01",
  userType: "customer" as const,
}

const CTX_GUEST = {
  channel: "web" as const,
  sessionId: "sess_02",
  userType: "guest" as const,
}

const PRODUCT_SUMMARY_A = {
  id: "prod_02",
  title: "Brisket Angus",
  price: 12900,
  imageUrl: "https://img.test/brisket.jpg",
}

const PRODUCT_SUMMARY_B = {
  id: "prod_03",
  title: "Molho BBQ",
  price: 1500,
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("getOrderedTogether", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns empty for guest (no customerId)", async () => {
    const result = await getOrderedTogether(
      { productId: "prod_01" },
      CTX_GUEST as any,
    )

    expect(result.products).toEqual([])
    expect(result.label).toBe("Você costuma pedir junto")
    expect(mockOrderItemFindMany).not.toHaveBeenCalled()
  })

  it("returns empty when customer has no orders with this product", async () => {
    mockOrderItemFindMany.mockResolvedValue([])

    const result = await getOrderedTogether(
      { productId: "prod_01" },
      CTX_AUTH,
    )

    expect(result.products).toEqual([])
    expect(result.label).toBe("Você costuma pedir junto")
    expect(mockOrderItemGroupBy).not.toHaveBeenCalled()
  })

  it("queries orders containing the specified product", async () => {
    mockOrderItemFindMany.mockResolvedValue([
      { medusaOrderId: "order_01" },
      { medusaOrderId: "order_02" },
    ])
    mockOrderItemGroupBy.mockResolvedValue([])

    await getOrderedTogether({ productId: "prod_01" }, CTX_AUTH)

    expect(mockOrderItemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: "cus_01", productId: "prod_01" },
        select: { medusaOrderId: true },
        distinct: ["medusaOrderId"],
      }),
    )
  })

  it("returns co-items ranked by frequency on happy path", async () => {
    mockOrderItemFindMany.mockResolvedValue([
      { medusaOrderId: "order_01" },
      { medusaOrderId: "order_02" },
    ])
    mockOrderItemGroupBy.mockResolvedValue([
      { productId: "prod_02", _count: { productId: 5 } },
      { productId: "prod_03", _count: { productId: 2 } },
    ])
    mockQueryProductsByIds.mockResolvedValue([PRODUCT_SUMMARY_A, PRODUCT_SUMMARY_B])

    const result = await getOrderedTogether(
      { productId: "prod_01" },
      CTX_AUTH,
    )

    expect(result.products).toHaveLength(2)
    expect(result.products[0].id).toBe("prod_02")
    expect(result.products[0].orderCount).toBe(5)
    expect(result.products[1].id).toBe("prod_03")
    expect(result.products[1].orderCount).toBe(2)
    expect(result.label).toBe("Você costuma pedir junto")
  })

  it("excludes the source product from co-items query", async () => {
    mockOrderItemFindMany.mockResolvedValue([
      { medusaOrderId: "order_01" },
    ])
    mockOrderItemGroupBy.mockResolvedValue([])

    await getOrderedTogether({ productId: "prod_01" }, CTX_AUTH)

    expect(mockOrderItemGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          productId: { not: "prod_01" },
          medusaOrderId: { in: ["order_01"] },
          customerId: "cus_01",
        }),
      }),
    )
  })

  it("returns empty when groupBy finds no co-items", async () => {
    mockOrderItemFindMany.mockResolvedValue([
      { medusaOrderId: "order_01" },
    ])
    mockOrderItemGroupBy.mockResolvedValue([])

    const result = await getOrderedTogether(
      { productId: "prod_01" },
      CTX_AUTH,
    )

    expect(result.products).toEqual([])
    expect(mockQueryProductsByIds).not.toHaveBeenCalled()
  })

  it("defaults orderCount to 1 when product not in countMap", async () => {
    mockOrderItemFindMany.mockResolvedValue([
      { medusaOrderId: "order_01" },
    ])
    mockOrderItemGroupBy.mockResolvedValue([
      { productId: "prod_02", _count: { productId: 3 } },
    ])
    // queryProductsByIds returns a product not in groupBy results
    mockQueryProductsByIds.mockResolvedValue([
      { id: "prod_99", title: "Fantasma", price: 0 },
    ])

    const result = await getOrderedTogether(
      { productId: "prod_01" },
      CTX_AUTH,
    )

    expect(result.products[0].orderCount).toBe(1)
  })

  it("passes at most 5 product IDs to queryProductsByIds", async () => {
    mockOrderItemFindMany.mockResolvedValue([
      { medusaOrderId: "order_01" },
    ])
    mockOrderItemGroupBy.mockResolvedValue([
      { productId: "p1", _count: { productId: 10 } },
      { productId: "p2", _count: { productId: 8 } },
      { productId: "p3", _count: { productId: 6 } },
      { productId: "p4", _count: { productId: 4 } },
      { productId: "p5", _count: { productId: 2 } },
    ])
    mockQueryProductsByIds.mockResolvedValue([])

    await getOrderedTogether({ productId: "prod_01" }, CTX_AUTH)

    expect(mockQueryProductsByIds).toHaveBeenCalledWith(
      ["p1", "p2", "p3", "p4", "p5"],
      5,
    )
  })
})
