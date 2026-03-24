// Tests for get_nutritional_info tool
// Covers: product with nutritional data, product without nutritional data

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}))

// ── Imports ──────────────────────────────────────────────────────────────────

import { getNutritionalInfo } from "../get-nutritional-info.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NUTRITIONAL_INFO = {
  per100g: {
    calories: 250,
    protein: 26,
    fat: 16,
    saturatedFat: 6,
    carbs: 0,
    sugars: 0,
    fiber: 0,
    sodium: 820,
  },
  servingSize: "100g",
  servingsPerPackage: 5,
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getNutritionalInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns ANVISA format nutritional info", async () => {
    mockMedusaAdmin.mockResolvedValue({
      product: {
        id: "prod_01",
        metadata: { nutritionalInfo: NUTRITIONAL_INFO },
      },
    })

    const result = await getNutritionalInfo({ productId: "prod_01" })

    expect(result).toEqual(NUTRITIONAL_INFO)
    expect(result!.per100g.calories).toBe(250)
    expect(result!.per100g.protein).toBe(26)
    expect(result!.servingSize).toBe("100g")
    expect(result!.servingsPerPackage).toBe(5)
    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/products/prod_01")
  })

  it("returns null when product has no nutritional data", async () => {
    mockMedusaAdmin.mockResolvedValue({
      product: {
        id: "prod_02",
        metadata: {},
      },
    })

    const result = await getNutritionalInfo({ productId: "prod_02" })

    expect(result).toBeNull()
    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/products/prod_02")
  })
})
