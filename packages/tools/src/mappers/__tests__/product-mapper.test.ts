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
    status: "published",
    tag_ids: ["popular", "sem_gluten"],
    variants: [
      {
        title: "Porção família (1,2kg)",
        sku: "COST-FAM-01",
        prices: [{ amount: 18900, currency_code: "BRL" }],
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
    expect(dto.variants).toEqual([]) // always empty from Typesense
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
})
