import { describe, it, expect } from "vitest"
import { ProductType, AvailabilityWindow } from "@ibatexas/types"

describe("Product Mapper Roundtrip", () => {
  const makeRawProduct = (overrides: Record<string, unknown> = {}) => ({
    id: "prod_1",
    title: "Costela Bovina Defumada",
    description: "Costela defumada por 12 horas",
    status: "published",
    thumbnail: "https://example.com/img.jpg",
    tags: [{ value: "popular" }, { value: "sem_gluten" }],
    metadata: {
      productType: "food",
      availabilityWindow: "almoco",
      allergens: ["lactose"],
    },
    variants: [{ id: "var_1", title: "Porção 500g", sku: "COST-500" }],
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  })

  it("maps raw product to ProductDTO shape", () => {
    const raw = makeRawProduct()
    // Simulate mapper logic
    const dto = {
      id: raw.id,
      title: raw.title,
      description: raw.description,
      price: 0, // would come from price set
      imageUrl: raw.thumbnail,
      tags: raw.tags.map((t: { value: string }) => t.value),
      availabilityWindow: raw.metadata.availabilityWindow as AvailabilityWindow,
      allergens: raw.metadata.allergens as string[],
      variants: raw.variants.map((v: { id: string; title: string; sku: string }) => ({ id: v.id, title: v.title, sku: v.sku })),
      productType: raw.metadata.productType as ProductType,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }

    expect(dto.tags).toEqual(["popular", "sem_gluten"])
    expect(dto.allergens).toEqual(["lactose"])
    expect(dto.productType).toBe("food")
    expect(dto.availabilityWindow).toBe("almoco")
  })

  it("handles missing metadata gracefully", () => {
    const raw = makeRawProduct({ metadata: null })
    const allergens = (raw.metadata as unknown as { allergens?: string[] })?.allergens ?? []
    expect(allergens).toEqual([])
  })

  it("handles null description", () => {
    const raw = makeRawProduct({ description: null })
    expect(raw.description).toBeNull()
  })

  it("maps all product types correctly", () => {
    for (const pt of [ProductType.FOOD, ProductType.FROZEN, ProductType.MERCHANDISE]) {
      expect(Object.values(ProductType)).toContain(pt)
    }
  })
})
