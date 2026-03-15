// Unit tests for product-mapper.ts — pure function tests (no network)

import { describe, it, expect } from "vitest"
import {
  medusaToTypesenseDoc,
  typesenseDocToDTO,
  type MedusaProductInput,
  type TypesenseProductDoc,
} from "../product-mapper.js"

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMedusa(overrides: Partial<MedusaProductInput> = {}): MedusaProductInput {
  return {
    id: "prod_01",
    title: "Costela Bovina Defumada",
    description: "12 horas de defumação lenta",
    thumbnail: "https://cdn.ibatexas.com/costela.jpg",
    images: [
      { id: "img_01", url: "https://cdn.ibatexas.com/costela.jpg", rank: 0 },
      { id: "img_02", url: "https://cdn.ibatexas.com/costela-2.jpg", rank: 1 },
    ],
    status: "published",
    tag_ids: ["popular", "sem_gluten"],
    variants: [
      {
        id: "variant_01",
        title: "Porção família (1,2kg)",
        sku: "COST-FAM-01",
        // Medusa v2 stores in reais (main currency unit)
        prices: [{ amount: 189, currency_code: "BRL" }],
      },
    ],
    metadata: {
      productType: "food",
      allergens: [],
      availabilityWindow: "jantar",
      inStock: true,
      preparationTimeMinutes: 30,
    },
    created_at: "2025-01-15T10:00:00Z",
    updated_at: "2025-01-16T12:00:00Z",
    ...overrides,
  }
}

function makeTypesenseDoc(overrides: Partial<TypesenseProductDoc> = {}): TypesenseProductDoc {
  return {
    id: "prod_01",
    title: "Costela Bovina Defumada",
    description: "12 horas de defumação lenta",
    price: 18900,
    imageUrl: "https://cdn.ibatexas.com/costela.jpg",
    images: ["https://cdn.ibatexas.com/costela.jpg", "https://cdn.ibatexas.com/costela-2.jpg"],
    tags: ["popular", "sem_gluten"],
    availabilityWindow: "jantar",
    allergens: [],
    productType: "food",
    status: "published",
    inStock: true,
    preparationTimeMinutes: 30,
    rating: null,
    reviewCount: null,
    createdAt: "2025-01-15T10:00:00Z",
    updatedAt: "2025-01-16T12:00:00Z",
    createdAtTimestamp: new Date("2025-01-15T10:00:00Z").getTime(),
    variantsJson: JSON.stringify([{ id: "variant_01", title: "Porção família (1,2kg)", sku: "COST-FAM-01", price: 18900 }]),
    ...overrides,
  }
}

// ── medusaToTypesenseDoc ──────────────────────────────────────────────────────

describe("medusaToTypesenseDoc", () => {
  it("maps all fields correctly", () => {
    const doc = medusaToTypesenseDoc(makeMedusa())
    expect(doc.id).toBe("prod_01")
    expect(doc.title).toBe("Costela Bovina Defumada")
    expect(doc.description).toBe("12 horas de defumação lenta")
    expect(doc.price).toBe(18900)
    expect(doc.imageUrl).toBe("https://cdn.ibatexas.com/costela.jpg")
    expect(doc.images).toEqual(["https://cdn.ibatexas.com/costela.jpg", "https://cdn.ibatexas.com/costela-2.jpg"])
    expect(doc.tags).toEqual(["popular", "sem_gluten"])
    expect(doc.availabilityWindow).toBe("jantar")
    expect(doc.allergens).toEqual([])
    expect(doc.productType).toBe("food")
    expect(doc.status).toBe("published")
    expect(doc.inStock).toBe(true)
    expect(doc.preparationTimeMinutes).toBe(30)
    expect(doc.createdAtTimestamp).toBeTypeOf("number")
  })

  it("defaults price to 0 when no variants", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ variants: [] }))
    expect(doc.price).toBe(0)
  })

  it("defaults price to 0 when variants have no prices", () => {
    const doc = medusaToTypesenseDoc(
      makeMedusa({ variants: [{ title: "x", prices: [] }] }),
    )
    expect(doc.price).toBe(0)
  })

  it("defaults description to empty string when null", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ description: null }))
    expect(doc.description).toBe("")
  })

  it("defaults thumbnail to null when missing", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ thumbnail: null }))
    expect(doc.imageUrl).toBeNull()
  })

  it("maps images sorted by rank", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({
      images: [
        { id: "img_b", url: "https://cdn.ibatexas.com/b.jpg", rank: 2 },
        { id: "img_a", url: "https://cdn.ibatexas.com/a.jpg", rank: 0 },
        { id: "img_c", url: "https://cdn.ibatexas.com/c.jpg", rank: 1 },
      ],
      thumbnail: "https://cdn.ibatexas.com/a.jpg",
    }))
    expect(doc.images).toEqual([
      "https://cdn.ibatexas.com/a.jpg",
      "https://cdn.ibatexas.com/c.jpg",
      "https://cdn.ibatexas.com/b.jpg",
    ])
  })

  it("prepends thumbnail to images when not in gallery", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({
      thumbnail: "https://cdn.ibatexas.com/thumb.jpg",
      images: [{ id: "img_01", url: "https://cdn.ibatexas.com/other.jpg", rank: 0 }],
    }))
    expect(doc.images).toEqual([
      "https://cdn.ibatexas.com/thumb.jpg",
      "https://cdn.ibatexas.com/other.jpg",
    ])
  })

  it("defaults images to empty array when missing", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ images: undefined, thumbnail: null }))
    expect(doc.images).toEqual([])
  })

  it("defaults tags to empty array when tag_ids missing", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ tag_ids: undefined }))
    expect(doc.tags).toEqual([])
  })

  it("defaults productType to 'food' when metadata missing", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ metadata: undefined }))
    expect(doc.productType).toBe("food")
  })

  it("extracts allergens from metadata array", () => {
    const doc = medusaToTypesenseDoc(
      makeMedusa({ metadata: { allergens: ["gluten", "leite"] } }),
    )
    expect(doc.allergens).toEqual(["gluten", "leite"])
  })

  it("defaults allergens to [] when metadata.allergens is not an array", () => {
    const doc = medusaToTypesenseDoc(
      makeMedusa({ metadata: { allergens: "gluten" } }),
    )
    expect(doc.allergens).toEqual([])
  })

  it("defaults availabilityWindow to 'sempre' when metadata missing", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ metadata: {} }))
    expect(doc.availabilityWindow).toBe("sempre")
  })

  it("sets inStock false only when explicitly false", () => {
    const doc = medusaToTypesenseDoc(
      makeMedusa({ metadata: { inStock: false } }),
    )
    expect(doc.inStock).toBe(false)
  })

  it("sets inStock true when metadata.inStock is undefined", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ metadata: {} }))
    expect(doc.inStock).toBe(true)
  })

  it("serializes variants to variantsJson", () => {
    const doc = medusaToTypesenseDoc(makeMedusa())
    expect(doc.variantsJson).toBeDefined()
    const variants = JSON.parse(doc.variantsJson!)
    expect(variants).toHaveLength(1)
    expect(variants[0]).toEqual({
      id: "variant_01",
      title: "Porção família (1,2kg)",
      sku: "COST-FAM-01",
      price: 18900,
    })
  })

  it("uses lowest variant price when multiple variants exist", () => {
    const doc = medusaToTypesenseDoc(
      makeMedusa({
        variants: [
          { id: "v1", title: "500g (individual)", sku: null, prices: [{ amount: 39, currency_code: "brl" }] },
          { id: "v2", title: "1kg (família)", sku: null, prices: [{ amount: 69, currency_code: "brl" }] },
        ],
      }),
    )
    expect(doc.price).toBe(3900) // lowest variant → 39 reais = 3900 centavos
    const variants = JSON.parse(doc.variantsJson!)
    expect(variants).toHaveLength(2)
    expect(variants[0].price).toBe(3900)
    expect(variants[1].price).toBe(6900)
  })

  it("sets variantsJson undefined when no variants", () => {
    const doc = medusaToTypesenseDoc(makeMedusa({ variants: [] }))
    expect(doc.variantsJson).toBeUndefined()
  })

  it("extracts prices from variant.price_set.prices (query.graph path)", () => {
    const doc = medusaToTypesenseDoc(
      makeMedusa({
        variants: [
          {
            id: "v1",
            title: "500g",
            sku: "SKU-500",
            // No direct `prices` — only price_set (as returned by query.graph)
            price_set: {
              id: "pset_01",
              prices: [{ amount: 45.5, currency_code: "brl" }],
            },
          },
          {
            id: "v2",
            title: "1kg",
            sku: "SKU-1K",
            price_set: {
              id: "pset_02",
              prices: [{ amount: 82, currency_code: "brl" }],
            },
          },
        ],
      }),
    )
    // Product-level price = lowest variant = 45.5 reais = 4550 centavos
    expect(doc.price).toBe(4550)
    const variants = JSON.parse(doc.variantsJson!)
    expect(variants).toHaveLength(2)
    expect(variants[0]).toEqual({ id: "v1", title: "500g", sku: "SKU-500", price: 4550 })
    expect(variants[1]).toEqual({ id: "v2", title: "1kg", sku: "SKU-1K", price: 8200 })
  })

  it("prefers variant.prices over variant.price_set.prices", () => {
    const doc = medusaToTypesenseDoc(
      makeMedusa({
        variants: [
          {
            id: "v1",
            title: "combo",
            sku: null,
            // Both present — direct prices should win
            prices: [{ amount: 50, currency_code: "brl" }],
            price_set: {
              id: "pset_01",
              prices: [{ amount: 99, currency_code: "brl" }],
            },
          },
        ],
      }),
    )
    expect(doc.price).toBe(5000) // 50 reais from direct prices, not 99
  })
})

// ── typesenseDocToDTO ─────────────────────────────────────────────────────────

describe("typesenseDocToDTO", () => {
  it("maps all fields to ProductDTO", () => {
    const dto = typesenseDocToDTO(makeTypesenseDoc())
    expect(dto.id).toBe("prod_01")
    expect(dto.title).toBe("Costela Bovina Defumada")
    expect(dto.price).toBe(18900)
    expect(dto.tags).toEqual(["popular", "sem_gluten"])
    expect(dto.allergens).toEqual([])
    expect(dto.variants).toEqual([{ id: "variant_01", title: "Porção família (1,2kg)", sku: "COST-FAM-01", price: 18900 }])
    expect(dto.productType).toBe("food")
    expect(dto.inStock).toBe(true)
  })

  it("defaults price to 0 when missing", () => {
    const dto = typesenseDocToDTO(makeTypesenseDoc({ price: undefined }))
    expect(dto.price).toBe(0)
  })

  it("defaults tags to [] when not an array", () => {
    const dto = typesenseDocToDTO(makeTypesenseDoc({ tags: undefined }))
    expect(dto.tags).toEqual([])
  })

  it("defaults allergens to [] when not an array", () => {
    const dto = typesenseDocToDTO(makeTypesenseDoc({ allergens: undefined }))
    expect(dto.allergens).toEqual([])
  })

  it("defaults description to empty string", () => {
    const dto = typesenseDocToDTO(makeTypesenseDoc({ description: undefined }))
    expect(dto.description).toBe("")
  })

  it("preserves optional numeric fields", () => {
    const dto = typesenseDocToDTO(
      makeTypesenseDoc({ rating: 4.5, reviewCount: 12 }),
    )
    expect(dto.rating).toBe(4.5)
    expect(dto.reviewCount).toBe(12)
  })

  it("omits optional numeric fields when null", () => {
    const dto = typesenseDocToDTO(
      makeTypesenseDoc({ rating: null, reviewCount: null }),
    )
    expect(dto.rating).toBeUndefined()
    expect(dto.reviewCount).toBeUndefined()
  })

  it("maps images array", () => {
    const dto = typesenseDocToDTO(
      makeTypesenseDoc({ images: ["https://cdn.ibatexas.com/a.jpg", "https://cdn.ibatexas.com/b.jpg"] }),
    )
    expect(dto.images).toEqual(["https://cdn.ibatexas.com/a.jpg", "https://cdn.ibatexas.com/b.jpg"])
  })

  it("defaults images to [] when missing", () => {
    const dto = typesenseDocToDTO(makeTypesenseDoc({ images: undefined }))
    expect(dto.images).toEqual([])
  })

  it("parses variantsJson into variants array", () => {
    const dto = typesenseDocToDTO(
      makeTypesenseDoc({
        variantsJson: JSON.stringify([
          { id: "v1", title: "500g", sku: "SKU-1", price: 3900 },
          { id: "v2", title: "1kg", sku: "SKU-2", price: 6900 },
        ]),
      }),
    )
    expect(dto.variants).toHaveLength(2)
    expect(dto.variants[0]).toEqual({ id: "v1", title: "500g", sku: "SKU-1", price: 3900 })
    expect(dto.variants[1]).toEqual({ id: "v2", title: "1kg", sku: "SKU-2", price: 6900 })
  })

  it("returns [] when variantsJson is missing", () => {
    const dto = typesenseDocToDTO(makeTypesenseDoc({ variantsJson: undefined }))
    expect(dto.variants).toEqual([])
  })

  it("returns [] when variantsJson is invalid JSON", () => {
    const dto = typesenseDocToDTO(makeTypesenseDoc({ variantsJson: "not-json" }))
    expect(dto.variants).toEqual([])
  })
})
