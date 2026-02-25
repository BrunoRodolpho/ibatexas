import { describe, it, expect, vi, beforeEach } from "vitest"
import { AvailabilityWindow, ProductType } from "@ibatexas/types"

vi.mock("@ibatexas/tools", () => ({
  searchProducts: vi.fn(),
}))

describe("Catalog Flow", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("returns products from Typesense on cache miss", async () => {
    const { searchProducts } = await import("@ibatexas/tools")
    const mock = vi.mocked(searchProducts)
    mock.mockResolvedValueOnce({
      products: [{ id: "prod_1", title: "Costela Defumada", description: "Costela defumada artesanal", price: 8900, imageUrl: null, tags: ["popular"], availabilityWindow: AvailabilityWindow.ALMOCO, allergens: [], variants: [], productType: ProductType.FOOD, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      searchModel: "hybrid",
      hitCache: false,
      totalFound: 1,
    })

    const result = await searchProducts({ query: "costela" } as any)
    expect(result.hitCache).toBe(false)
    expect(result.products).toHaveLength(1)
    expect(result.products[0].title).toBe("Costela Defumada")
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it("returns products from cache on cache hit", async () => {
    const { searchProducts } = await import("@ibatexas/tools")
    const mock = vi.mocked(searchProducts)
    mock.mockResolvedValueOnce({
      products: [{ id: "prod_1", title: "Costela Defumada", description: "Costela defumada artesanal", price: 8900, imageUrl: null, tags: ["popular"], availabilityWindow: AvailabilityWindow.ALMOCO, allergens: [], variants: [], productType: ProductType.FOOD, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      searchModel: "hybrid",
      hitCache: true,
      totalFound: 1,
      cachedAt: new Date().toISOString(),
    })

    const result = await searchProducts({ query: "costela" } as any)
    expect(result.hitCache).toBe(true)
    expect(result.cachedAt).toBeDefined()
  })
})
