// Tests for syncReviewStats batch sync
// Mock-based; no database or Typesense required.
//
// Scenarios:
// - No reviews: returns {synced: 0, skipped: 0}
// - Happy path: updates each product in Typesense
// - Typesense failure for a product: increments skipped
// - Null productId in groupBy results: skipped
// - Mixed success and failure
// - Uses aggregate _avg and _count correctly

import { describe, it, expect, beforeEach, vi } from "vitest"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockReviewGroupBy = vi.hoisted(() => vi.fn())
const mockTypesenseUpdate = vi.hoisted(() => vi.fn())
const mockGetTypesenseClient = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    review: {
      groupBy: mockReviewGroupBy,
    },
  },
}))

vi.mock("../../typesense/client.js", () => ({
  getTypesenseClient: mockGetTypesenseClient,
  COLLECTION: "products",
}))

// -- Imports ──────────────────────────────────────────────────────────────────

import { syncReviewStats } from "../sync-review-stats.js"

// -- Tests ────────────────────────────────────────────────────────────────────

describe("syncReviewStats", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTypesenseClient.mockReturnValue({
      collections: () => ({
        documents: (id: string) => ({
          update: mockTypesenseUpdate,
        }),
      }),
    })
    mockTypesenseUpdate.mockResolvedValue({})
  })

  it("returns {synced: 0, skipped: 0} when no reviews exist", async () => {
    mockReviewGroupBy.mockResolvedValue([])

    const result = await syncReviewStats()

    expect(result).toEqual({ synced: 0, skipped: 0 })
    expect(mockGetTypesenseClient).not.toHaveBeenCalled()
  })

  it("updates each product in Typesense on happy path", async () => {
    mockReviewGroupBy.mockResolvedValue([
      { productId: "prod_01", _avg: { rating: 4.5 }, _count: { rating: 10 } },
      { productId: "prod_02", _avg: { rating: 3.0 }, _count: { rating: 5 } },
    ])

    const result = await syncReviewStats()

    expect(result).toEqual({ synced: 2, skipped: 0 })
    expect(mockTypesenseUpdate).toHaveBeenCalledTimes(2)
    expect(mockTypesenseUpdate).toHaveBeenCalledWith({
      rating: 4.5,
      reviewCount: 10,
    })
    expect(mockTypesenseUpdate).toHaveBeenCalledWith({
      rating: 3.0,
      reviewCount: 5,
    })
  })

  it("increments skipped when Typesense update fails", async () => {
    mockReviewGroupBy.mockResolvedValue([
      { productId: "prod_01", _avg: { rating: 4.0 }, _count: { rating: 8 } },
      { productId: "prod_02", _avg: { rating: 5.0 }, _count: { rating: 2 } },
    ])
    mockTypesenseUpdate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Typesense 404"))

    const result = await syncReviewStats()

    expect(result).toEqual({ synced: 1, skipped: 1 })
  })

  it("skips null productId in groupBy results", async () => {
    mockReviewGroupBy.mockResolvedValue([
      { productId: null, _avg: { rating: 3.0 }, _count: { rating: 1 } },
      { productId: "prod_01", _avg: { rating: 4.0 }, _count: { rating: 5 } },
    ])

    const result = await syncReviewStats()

    expect(result).toEqual({ synced: 1, skipped: 1 })
    expect(mockTypesenseUpdate).toHaveBeenCalledTimes(1)
  })

  it("defaults _avg.rating to 0 when null", async () => {
    mockReviewGroupBy.mockResolvedValue([
      { productId: "prod_01", _avg: { rating: null }, _count: { rating: 3 } },
    ])

    const result = await syncReviewStats()

    expect(result).toEqual({ synced: 1, skipped: 0 })
    expect(mockTypesenseUpdate).toHaveBeenCalledWith({
      rating: 0,
      reviewCount: 3,
    })
  })

  it("queries groupBy with correct parameters", async () => {
    mockReviewGroupBy.mockResolvedValue([])

    await syncReviewStats()

    expect(mockReviewGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["productId"],
        _avg: { rating: true },
        _count: { rating: true },
        where: { productId: { not: null } },
      }),
    )
  })

  it("handles mixed success, failure, and null productIds", async () => {
    mockReviewGroupBy.mockResolvedValue([
      { productId: "prod_01", _avg: { rating: 4.0 }, _count: { rating: 10 } },
      { productId: null, _avg: { rating: 3.0 }, _count: { rating: 1 } },
      { productId: "prod_02", _avg: { rating: 5.0 }, _count: { rating: 20 } },
      { productId: "prod_03", _avg: { rating: 2.0 }, _count: { rating: 3 } },
    ])
    mockTypesenseUpdate
      .mockResolvedValueOnce({})       // prod_01 ok
      .mockRejectedValueOnce(new Error("fail")) // prod_02 fail
      .mockResolvedValueOnce({})       // prod_03 ok

    const result = await syncReviewStats()

    // 2 synced (prod_01, prod_03), 2 skipped (null productId, prod_02 fail)
    expect(result).toEqual({ synced: 2, skipped: 2 })
  })
})
