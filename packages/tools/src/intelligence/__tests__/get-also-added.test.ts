// Tests for get_also_added tool
// Mock-based; no Redis or Typesense required.
//
// Scenarios:
// - Happy path: returns co-purchased products with label
// - Empty sorted set: returns empty products array
// - Custom limit
// - Default limit is 6
// - Uses rk() for Redis key

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { AgentContext } from "@ibatexas/types"
import { getAlsoAdded } from "../get-also-added.js"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockZRangeWithScores = vi.hoisted(() => vi.fn())
const mockGetRedisClient = vi.hoisted(() => vi.fn())
const mockRk = vi.hoisted(() => vi.fn())
const mockQueryProductsByIds = vi.hoisted(() => vi.fn())

vi.mock("../../redis/client.js", () => ({
  getRedisClient: mockGetRedisClient,
}))

vi.mock("../../redis/key.js", () => ({
  rk: mockRk,
}))

vi.mock("../query-products-by-ids.js", () => ({
  queryProductsByIds: mockQueryProductsByIds,
}))

// -- Fixtures ─────────────────────────────────────────────────────────────────

const CTX = {
  channel: "web" as const,
  sessionId: "sess_01",
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

describe("getAlsoAdded", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRk.mockImplementation((key: string) => key)
    mockGetRedisClient.mockResolvedValue({
      zRangeWithScores: mockZRangeWithScores,
    })
  })

  it("returns co-purchased products with correct label on happy path", async () => {
    mockZRangeWithScores.mockResolvedValue([
      { value: "prod_02", score: 10 },
      { value: "prod_03", score: 5 },
    ])
    mockQueryProductsByIds.mockResolvedValue([PRODUCT_SUMMARY_A, PRODUCT_SUMMARY_B])

    const result = await getAlsoAdded({ productId: "prod_01" }, CTX as AgentContext)

    expect(result.label).toBe("Clientes também adicionam")
    expect(result.products).toHaveLength(2)
    expect(result.products[0].id).toBe("prod_02")
    expect(result.products[1].id).toBe("prod_03")
  })

  it("uses rk() to build the copurchase key", async () => {
    mockZRangeWithScores.mockResolvedValue([])

    await getAlsoAdded({ productId: "prod_01" }, CTX as AgentContext)

    expect(mockRk).toHaveBeenCalledWith("copurchase:prod_01")
  })

  it("returns empty products when sorted set is empty", async () => {
    mockZRangeWithScores.mockResolvedValue([])

    const result = await getAlsoAdded({ productId: "prod_01" }, CTX as AgentContext)

    expect(result.products).toEqual([])
    expect(result.label).toBe("Clientes também adicionam")
    expect(mockQueryProductsByIds).not.toHaveBeenCalled()
  })

  it("defaults limit to 6", async () => {
    mockZRangeWithScores.mockResolvedValue([])

    await getAlsoAdded({ productId: "prod_01" }, CTX as AgentContext)

    expect(mockZRangeWithScores).toHaveBeenCalledWith(
      "copurchase:prod_01",
      0,
      5, // limit - 1 = 5
      { REV: true },
    )
  })

  it("respects custom limit", async () => {
    mockZRangeWithScores.mockResolvedValue([
      { value: "prod_02", score: 10 },
    ])
    mockQueryProductsByIds.mockResolvedValue([PRODUCT_SUMMARY_A])

    await getAlsoAdded({ productId: "prod_01", limit: 3 }, CTX as AgentContext)

    expect(mockZRangeWithScores).toHaveBeenCalledWith(
      "copurchase:prod_01",
      0,
      2, // limit - 1 = 2
      { REV: true },
    )
    expect(mockQueryProductsByIds).toHaveBeenCalledWith(["prod_02"], 3)
  })

  it("passes productIds from Redis to queryProductsByIds", async () => {
    mockZRangeWithScores.mockResolvedValue([
      { value: "prod_02", score: 20 },
      { value: "prod_03", score: 15 },
      { value: "prod_04", score: 5 },
    ])
    mockQueryProductsByIds.mockResolvedValue([])

    await getAlsoAdded({ productId: "prod_01" }, CTX as AgentContext)

    expect(mockQueryProductsByIds).toHaveBeenCalledWith(
      ["prod_02", "prod_03", "prod_04"],
      6,
    )
  })

  it("works without auth context (no customerId required)", async () => {
    mockZRangeWithScores.mockResolvedValue([])

    const result = await getAlsoAdded({ productId: "prod_01" }, CTX as AgentContext)

    expect(result.products).toEqual([])
  })
})
