// Tests for get_customer_profile tool
// Mock-based; no database or Redis required.
//
// Scenarios:
// - Auth check: throws when no customerId
// - Cache hit: returns parsed profile from Redis, resets TTL
// - Cache miss: hydrates from Prisma, writes pipeline to Redis
// - Decay score formula: quantity / max(1, daysSince)
// - Empty order history: zero scores, null lastOrderAt
// - Malformed JSON in Redis: falls back gracefully

import { describe, it, expect, beforeEach, vi } from "vitest"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockHGetAll = vi.hoisted(() => vi.fn())
const mockExpire = vi.hoisted(() => vi.fn())
const mockHSet = vi.hoisted(() => vi.fn())
const mockPipelineExpire = vi.hoisted(() => vi.fn())
const mockPipelineExec = vi.hoisted(() => vi.fn())

const mockMulti = vi.hoisted(() =>
  vi.fn(() => ({
    hSet: mockHSet,
    expire: mockPipelineExpire,
    exec: mockPipelineExec,
  })),
)

const mockGetRedisClient = vi.hoisted(() => vi.fn())
const mockRk = vi.hoisted(() => vi.fn())
const mockPrefsFindUnique = vi.hoisted(() => vi.fn())
const mockOrderItemFindMany = vi.hoisted(() => vi.fn())

vi.mock("../../redis/client.js", () => ({
  getRedisClient: mockGetRedisClient,
}))

vi.mock("../../redis/key.js", () => ({
  rk: mockRk,
}))

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    customerPreferences: {
      findUnique: mockPrefsFindUnique,
    },
    customerOrderItem: {
      findMany: mockOrderItemFindMany,
    },
  },
  createCustomerService: () => ({
    getProfileData: async (customerId: string) => {
      const [customerPrefs, orderItems] = await Promise.all([
        mockPrefsFindUnique({ where: { customerId } }),
        mockOrderItemFindMany({ where: { customerId }, orderBy: { orderedAt: "desc" }, take: 200 }),
      ])
      return { customerPrefs, orderItems }
    },
  }),
}))

// -- Imports ──────────────────────────────────────────────────────────────────

import { Channel } from "@ibatexas/types"
import { getCustomerProfile } from "../get-customer-profile.js"
import { PROFILE_TTL_SECONDS } from "../types.js"

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

const REDIS_PROFILE_HIT = {
  recentlyViewed: JSON.stringify([{ productId: "prod_01", viewedAt: "2026-03-01T12:00:00Z" }]),
  cartItems: JSON.stringify(["var_01"]),
  orderCount: "3",
  lastOrderAt: "2026-02-28T10:00:00Z",
  lastOrderedProductIds: JSON.stringify(["prod_01", "prod_02"]),
  preferences: JSON.stringify({
    dietaryRestrictions: ["sem glúten"],
    allergenExclusions: ["lactose"],
    favoriteCategories: ["churrasco"],
  }),
  "score:prod_01": "2.5",
  "score:prod_02": "1.0",
}

const PREFS_ROW = {
  customerId: "cus_01",
  dietaryRestrictions: ["vegetariano"],
  allergenExclusions: ["amendoim"],
  favoriteCategories: ["grelhados"],
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("getCustomerProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRk.mockImplementation((key: string) => key)
    mockGetRedisClient.mockResolvedValue({
      hGetAll: mockHGetAll,
      expire: mockExpire,
      multi: mockMulti,
    })
    mockPipelineExec.mockResolvedValue([])
  })

  it("throws when customerId is missing", async () => {
    await expect(getCustomerProfile({}, CTX_GUEST as any)).rejects.toThrow(
      "Autenticação necessária",
    )
  })

  it("uses rk() to build the profile key", async () => {
    mockHGetAll.mockResolvedValue(REDIS_PROFILE_HIT)

    await getCustomerProfile({}, CTX_AUTH)

    expect(mockRk).toHaveBeenCalledWith("customer:profile:cus_01")
  })

  // ── Cache hit ───────────────────────────────────────────────────────────

  it("returns parsed profile from Redis on cache hit", async () => {
    mockHGetAll.mockResolvedValue(REDIS_PROFILE_HIT)

    const result = await getCustomerProfile({}, CTX_AUTH)

    expect(result.customerId).toBe("cus_01")
    expect(result.orderCount).toBe(3)
    expect(result.lastOrderAt).toBe("2026-02-28T10:00:00Z")
    expect(result.recentlyViewed).toEqual([
      { productId: "prod_01", viewedAt: "2026-03-01T12:00:00Z" },
    ])
    expect(result.cartItems).toEqual(["var_01"])
    expect(result.lastOrderedProductIds).toEqual(["prod_01", "prod_02"])
    expect(result.preferences).toEqual({
      dietaryRestrictions: ["sem glúten"],
      allergenExclusions: ["lactose"],
      favoriteCategories: ["churrasco"],
    })
    expect(result.orderedProductScore).toEqual({ prod_01: 2.5, prod_02: 1.0 })
  })

  it("resets sliding TTL on cache hit", async () => {
    mockHGetAll.mockResolvedValue(REDIS_PROFILE_HIT)

    await getCustomerProfile({}, CTX_AUTH)

    expect(mockExpire).toHaveBeenCalledWith(
      "customer:profile:cus_01",
      PROFILE_TTL_SECONDS,
    )
  })

  it("does not query Prisma on cache hit", async () => {
    mockHGetAll.mockResolvedValue(REDIS_PROFILE_HIT)

    await getCustomerProfile({}, CTX_AUTH)

    expect(mockPrefsFindUnique).not.toHaveBeenCalled()
    expect(mockOrderItemFindMany).not.toHaveBeenCalled()
  })

  // ── Cache miss ──────────────────────────────────────────────────────────

  it("hydrates from Prisma on cache miss (empty hash)", async () => {
    mockHGetAll.mockResolvedValue({})

    const now = Date.now()
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000)
    mockOrderItemFindMany.mockResolvedValue([
      {
        productId: "prod_01",
        medusaOrderId: "order_01",
        quantity: 2,
        orderedAt: twoDaysAgo,
      },
      {
        productId: "prod_02",
        medusaOrderId: "order_01",
        quantity: 1,
        orderedAt: twoDaysAgo,
      },
    ])
    mockPrefsFindUnique.mockResolvedValue(PREFS_ROW)

    const result = await getCustomerProfile({}, CTX_AUTH)

    expect(result.customerId).toBe("cus_01")
    expect(result.orderCount).toBe(1)
    expect(result.lastOrderedProductIds).toContain("prod_01")
    expect(result.lastOrderedProductIds).toContain("prod_02")
    expect(result.preferences).toEqual({
      dietaryRestrictions: ["vegetariano"],
      allergenExclusions: ["amendoim"],
      favoriteCategories: ["grelhados"],
    })
  })

  it("writes to Redis pipeline on cache miss", async () => {
    mockHGetAll.mockResolvedValue({})
    mockOrderItemFindMany.mockResolvedValue([])
    mockPrefsFindUnique.mockResolvedValue(null)

    await getCustomerProfile({}, CTX_AUTH)

    expect(mockMulti).toHaveBeenCalledOnce()
    expect(mockHSet).toHaveBeenCalled()
    expect(mockPipelineExpire).toHaveBeenCalledWith(
      "customer:profile:cus_01",
      PROFILE_TTL_SECONDS,
    )
    expect(mockPipelineExec).toHaveBeenCalledOnce()
  })

  it("computes decay scores: quantity / max(1, daysSince)", async () => {
    mockHGetAll.mockResolvedValue({})

    const now = Date.now()
    // 10 days ago
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000)
    mockOrderItemFindMany.mockResolvedValue([
      {
        productId: "prod_01",
        medusaOrderId: "order_01",
        quantity: 5,
        orderedAt: tenDaysAgo,
      },
    ])
    mockPrefsFindUnique.mockResolvedValue(null)

    const result = await getCustomerProfile({}, CTX_AUTH)

    // score = quantity / daysSince = 5 / 10 = 0.5
    expect(result.orderedProductScore["prod_01"]).toBeCloseTo(0.5, 1)
  })

  it("returns null lastOrderAt when no orders", async () => {
    mockHGetAll.mockResolvedValue({})
    mockOrderItemFindMany.mockResolvedValue([])
    mockPrefsFindUnique.mockResolvedValue(null)

    const result = await getCustomerProfile({}, CTX_AUTH)

    expect(result.lastOrderAt).toBeNull()
    expect(result.orderCount).toBe(0)
    expect(result.orderedProductScore).toEqual({})
    expect(result.lastOrderedProductIds).toEqual([])
  })

  it("returns null preferences when customer has none", async () => {
    mockHGetAll.mockResolvedValue({})
    mockOrderItemFindMany.mockResolvedValue([])
    mockPrefsFindUnique.mockResolvedValue(null)

    const result = await getCustomerProfile({}, CTX_AUTH)

    expect(result.preferences).toBeNull()
  })

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("handles malformed JSON in Redis gracefully", async () => {
    mockHGetAll.mockResolvedValue({
      recentlyViewed: "NOT_VALID_JSON",
      cartItems: "ALSO_INVALID",
      orderCount: "abc",
      lastOrderAt: "",
      lastOrderedProductIds: "",
      preferences: "",
    })

    const result = await getCustomerProfile({}, CTX_AUTH)

    expect(result.recentlyViewed).toEqual([])
    expect(result.cartItems).toEqual([])
    expect(result.orderCount).toBeNaN()
    expect(result.lastOrderAt).toBeNull()
    expect(result.lastOrderedProductIds).toEqual([])
    expect(result.preferences).toBeNull()
  })

  it("handles hGetAll returning null gracefully", async () => {
    mockHGetAll.mockResolvedValue(null)
    mockOrderItemFindMany.mockResolvedValue([])
    mockPrefsFindUnique.mockResolvedValue(null)

    const result = await getCustomerProfile({}, CTX_AUTH)

    // Falls through to Prisma hydration path
    expect(result.customerId).toBe("cus_01")
    expect(mockPrefsFindUnique).toHaveBeenCalled()
  })

  it("sums decay scores across multiple order items for same product", async () => {
    mockHGetAll.mockResolvedValue({})

    const now = Date.now()
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000)
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000)

    mockOrderItemFindMany.mockResolvedValue([
      { productId: "prod_01", medusaOrderId: "order_01", quantity: 2, orderedAt: oneDayAgo },
      { productId: "prod_01", medusaOrderId: "order_02", quantity: 5, orderedAt: fiveDaysAgo },
    ])
    mockPrefsFindUnique.mockResolvedValue(null)

    const result = await getCustomerProfile({}, CTX_AUTH)

    // score = 2/1 + 5/5 = 2 + 1 = 3
    expect(result.orderedProductScore["prod_01"]).toBeCloseTo(3, 1)
  })
})
