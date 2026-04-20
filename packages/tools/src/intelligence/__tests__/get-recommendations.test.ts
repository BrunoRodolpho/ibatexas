// Tests for get_recommendations tool
// Mock-based; no Typesense, Redis, or DB required.
//
// Scenarios:
// - Authenticated: personalized query via buildPersonalizedQuery
// - Guest: global bestsellers from Redis sorted set
// - Guest cold start: highest-rated products from Typesense
// - Empty results: appropriate fallback messages
// - buildPersonalizedQuery: allergen exclusion filters, favorite category boost

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Channel } from "@ibatexas/types"
import type { AgentContext } from "@ibatexas/types"
import {
  getRecommendations,
  buildPersonalizedQuery,
} from "../get-recommendations.js"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockSearch = vi.hoisted(() => vi.fn())
const mockGetTypesenseClient = vi.hoisted(() => vi.fn())
const mockGetRedisClient = vi.hoisted(() => vi.fn())
const mockRk = vi.hoisted(() => vi.fn())
const mockQueryProductsByIds = vi.hoisted(() => vi.fn())
const mockHGet = vi.hoisted(() => vi.fn())
const mockZRangeWithScores = vi.hoisted(() => vi.fn())

vi.mock("../../typesense/client.js", () => ({
  getTypesenseClient: mockGetTypesenseClient,
  COLLECTION: "products",
}))

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

const CTX_AUTH = {
  customerId: "cus_01",
  channel: Channel.WhatsApp,
  sessionId: "sess_01",
  userType: "customer" as const,
}

const CTX_GUEST = {
  channel: Channel.Web,
  sessionId: "sess_02",
  userType: "guest" as const,
}

const HIT_A = {
  document: {
    id: "prod_01",
    title: "Costela Bovina Defumada",
    price: 8900,
    imageUrl: "https://img.test/costela.jpg",
  },
}

const HIT_B = {
  document: {
    id: "prod_02",
    title: "Brisket Angus",
    price: 12900,
    imageUrl: null,
  },
}

const PRODUCT_SUMMARY_A = {
  id: "prod_01",
  title: "Costela Bovina Defumada",
  price: 8900,
  imageUrl: "https://img.test/costela.jpg",
}

const PRODUCT_SUMMARY_B = {
  id: "prod_02",
  title: "Brisket Angus",
  price: 12900,
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("buildPersonalizedQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRk.mockImplementation((key: string) => key)
    mockGetRedisClient.mockResolvedValue({ hGet: mockHGet })
  })

  it("returns base filters when no preferences exist", async () => {
    mockHGet.mockResolvedValue(null)

    const result = await buildPersonalizedQuery("cus_01")

    expect(result.filterBy).toBe("inStock:=true && status:=published")
    expect(result.sortBy).toBe("_vector_distance:asc")
  })

  it("uses rk() to build the profile key", async () => {
    mockHGet.mockResolvedValue(null)

    await buildPersonalizedQuery("cus_01")

    expect(mockRk).toHaveBeenCalledWith("customer:profile:cus_01")
  })

  it("adds allergen exclusion filter when present", async () => {
    mockHGet.mockResolvedValue(
      JSON.stringify({
        allergenExclusions: ["lactose", "gluten"],
        favoriteCategories: [],
      }),
    )

    const result = await buildPersonalizedQuery("cus_01")

    expect(result.filterBy).toContain("allergens:!=[lactose,gluten]")
  })

  it("boosts favorite categories in sortBy when present", async () => {
    mockHGet.mockResolvedValue(
      JSON.stringify({
        allergenExclusions: [],
        favoriteCategories: ["churrasco", "grelhados"],
      }),
    )

    const result = await buildPersonalizedQuery("cus_01")

    expect(result.sortBy).toContain("churrasco")
    expect(result.sortBy).toContain("grelhados")
    expect(result.sortBy).toContain("rating:desc")
  })

  it("limits favorite categories to 3 in sortBy", async () => {
    mockHGet.mockResolvedValue(
      JSON.stringify({
        allergenExclusions: [],
        favoriteCategories: ["a", "b", "c", "d"],
      }),
    )

    const result = await buildPersonalizedQuery("cus_01")

    // Only first 3 categories should appear
    expect(result.sortBy).toContain("a")
    expect(result.sortBy).toContain("b")
    expect(result.sortBy).toContain("c")
    expect(result.sortBy).not.toContain(",d")
  })

  it("does not add allergen filter when exclusions array is empty", async () => {
    mockHGet.mockResolvedValue(
      JSON.stringify({
        allergenExclusions: [],
        favoriteCategories: [],
      }),
    )

    const result = await buildPersonalizedQuery("cus_01")

    expect(result.filterBy).not.toContain("allergens")
  })
})

describe("getRecommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRk.mockImplementation((key: string) => key)
    mockGetRedisClient.mockResolvedValue({
      hGet: mockHGet,
      zRangeWithScores: mockZRangeWithScores,
    })
    mockGetTypesenseClient.mockReturnValue({
      collections: () => ({
        documents: () => ({
          search: mockSearch,
        }),
      }),
    })
    mockHGet.mockResolvedValue(null) // no prefs by default
  })

  // ── Authenticated path ──────────────────────────────────────────────────

  it("returns personalized results for authenticated customer", async () => {
    mockSearch.mockResolvedValue({ hits: [HIT_A, HIT_B] })

    const result = await getRecommendations({}, CTX_AUTH)

    expect(result.products).toHaveLength(2)
    expect(result.products[0].id).toBe("prod_01")
    expect(result.products[0].reason).toBe("Baseado nas suas preferências")
    expect(result.message).toContain("2 produto(s)")
  })

  it("returns fallback message when no personalized products found", async () => {
    mockSearch.mockResolvedValue({ hits: [] })

    const result = await getRecommendations({}, CTX_AUTH)

    expect(result.products).toHaveLength(0)
    expect(result.message).toContain("cardápio completo")
  })

  it("respects custom limit parameter", async () => {
    mockSearch.mockResolvedValue({ hits: [HIT_A] })

    await getRecommendations({ limit: 5 }, CTX_AUTH)

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 5 }),
    )
  })

  it("defaults limit to 10", async () => {
    mockSearch.mockResolvedValue({ hits: [] })

    await getRecommendations({}, CTX_AUTH)

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 10 }),
    )
  })

  it("maps imageUrl to undefined when null", async () => {
    mockSearch.mockResolvedValue({ hits: [HIT_B] })

    const result = await getRecommendations({}, CTX_AUTH)

    expect(result.products[0].imageUrl).toBeUndefined()
  })

  it("defaults price to 0 when missing", async () => {
    mockSearch.mockResolvedValue({
      hits: [{ document: { id: "prod_x", title: "Sem Preco", price: undefined } }],
    })

    const result = await getRecommendations({}, CTX_AUTH)

    expect(result.products[0].price).toBe(0)
  })

  // ── Guest path: global bestsellers ──────────────────────────────────────

  it("returns global bestsellers for guest when scores exist", async () => {
    mockZRangeWithScores.mockResolvedValue([
      { value: "prod_01", score: 50 },
      { value: "prod_02", score: 30 },
    ])
    mockQueryProductsByIds.mockResolvedValue([PRODUCT_SUMMARY_A, PRODUCT_SUMMARY_B])

    const result = await getRecommendations({}, CTX_GUEST as AgentContext)

    expect(result.products).toHaveLength(2)
    expect(result.products[0].reason).toBe("Mais pedidos")
    expect(result.message).toContain("mais pedidos")
    expect(mockRk).toHaveBeenCalledWith("product:global:score")
  })

  it("uses queryProductsByIds for guest bestseller path", async () => {
    mockZRangeWithScores.mockResolvedValue([
      { value: "prod_01", score: 50 },
    ])
    mockQueryProductsByIds.mockResolvedValue([PRODUCT_SUMMARY_A])

    await getRecommendations({ limit: 3 }, CTX_GUEST as AgentContext)

    expect(mockQueryProductsByIds).toHaveBeenCalledWith(["prod_01"], 3)
  })

  // ── Guest cold start fallback ───────────────────────────────────────────

  it("falls back to highest-rated products when no global scores", async () => {
    mockZRangeWithScores.mockResolvedValue([])
    mockSearch.mockResolvedValue({ hits: [HIT_A] })

    const result = await getRecommendations({}, CTX_GUEST as AgentContext)

    expect(result.products[0].reason).toBe("Bem avaliado por outros clientes")
    expect(result.message).toContain("mais bem avaliados")
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        filter_by: "inStock:=true && status:=published && reviewCount:>=5",
        sort_by: "rating:desc",
      }),
    )
  })

  it("falls back to highest-rated when queryProductsByIds returns empty", async () => {
    mockZRangeWithScores.mockResolvedValue([
      { value: "prod_01", score: 10 },
    ])
    mockQueryProductsByIds.mockResolvedValue([]) // No products found
    mockSearch.mockResolvedValue({ hits: [HIT_A] })

    const result = await getRecommendations({}, CTX_GUEST as AgentContext)

    expect(result.products[0].reason).toBe("Bem avaliado por outros clientes")
  })

  it("returns explore message when cold start also returns empty", async () => {
    mockZRangeWithScores.mockResolvedValue([])
    mockSearch.mockResolvedValue({ hits: [] })

    const result = await getRecommendations({}, CTX_GUEST as AgentContext)

    expect(result.products).toHaveLength(0)
    expect(result.message).toContain("cardápio completo")
  })
})
