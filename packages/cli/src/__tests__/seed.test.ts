import { describe, it, expect } from "vitest"
import {
  SEED_PRODUCTS,
  CATEGORIES,
} from "../../../../apps/commerce/src/seed-data"

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_PRODUCT_TYPES = ["food", "frozen", "merchandise"] as const
const VALID_AVAILABILITY_WINDOWS = ["almoco", "jantar", "congelados", "always"] as const
const VALID_TAGS = [
  "popular", "chef_choice", "sem_gluten", "sem_lactose",
  "vegano", "vegetariano", "novo", "congelado", "defumado",
] as const
const NUTRITIONAL_FIELDS = ["calories", "protein", "fat", "carbs", "sodium"] as const
const KEBAB_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

// ── Category tests ─────────────────────────────────────────────────────────────

describe("Category definitions", () => {
  it("has exactly one root (parent: null)", () => {
    const roots = CATEGORIES.filter((c) => c.parent === null)
    expect(roots.length, "Expected exactly one root category").toBe(1)
  })

  it("all child categories reference an existing parent handle", () => {
    const handles = new Set(CATEGORIES.map((c) => c.handle))
    const children = CATEGORIES.filter((c) => c.parent !== null)
    for (const child of children) {
      expect(
        handles.has(child.parent!),
        `Category "${child.handle}" references non-existent parent "${child.parent}"`
      ).toBe(true)
    }
  })

  it("all category handles are lowercase kebab-case", () => {
    for (const cat of CATEGORIES) {
      expect(
        KEBAB_REGEX.test(cat.handle),
        `Category handle "${cat.handle}" is not valid kebab-case`
      ).toBe(true)
    }
  })

  it("no duplicate category handles", () => {
    const handles = CATEGORIES.map((c) => c.handle)
    const unique = new Set(handles)
    expect(unique.size, `Duplicate category handles found`).toBe(handles.length)
  })

  it("all category names are non-empty", () => {
    for (const cat of CATEGORIES) {
      expect(
        cat.name.trim().length,
        `Category "${cat.handle}" has empty name`
      ).toBeGreaterThan(0)
    }
  })
})

// ── Product structure tests ────────────────────────────────────────────────────

describe("Seed data — structural validation", () => {
  it("all products have required metadata fields", () => {
    for (const product of SEED_PRODUCTS) {
      expect(product.metadata, `${product.title} is missing metadata`).toBeDefined()

      expect(
        product.metadata.productType,
        `${product.title}: missing productType`
      ).toBeDefined()

      expect(
        (VALID_PRODUCT_TYPES as readonly string[]).includes(product.metadata.productType),
        `${product.title}: invalid productType "${product.metadata.productType}"`
      ).toBe(true)

      expect(
        product.metadata.availabilityWindow,
        `${product.title}: missing availabilityWindow`
      ).toBeDefined()

      expect(
        (VALID_AVAILABILITY_WINDOWS as readonly string[]).includes(
          product.metadata.availabilityWindow
        ),
        `${product.title}: invalid availabilityWindow "${product.metadata.availabilityWindow}"`
      ).toBe(true)

      expect(
        product.metadata.nutritionalInfo,
        `${product.title}: missing nutritionalInfo`
      ).toBeDefined()

      expect(
        Array.isArray(product.metadata.allergens),
        `${product.title}: allergens must be an array`
      ).toBe(true)
    }
  })

  it("allergens are always an explicit array — never undefined or null", () => {
    for (const product of SEED_PRODUCTS) {
      expect(
        Array.isArray(product.metadata.allergens),
        `${product.title}: allergens must be an array, got ${typeof product.metadata.allergens}`
      ).toBe(true)

      // Ensure no allergen value is falsy/empty string
      for (const allergen of product.metadata.allergens) {
        expect(
          typeof allergen === "string" && allergen.trim().length > 0,
          `${product.title}: allergen value must be a non-empty string, got "${allergen}"`
        ).toBe(true)
      }
    }
  })

  it("all prices are positive integers in centavos (no floats)", () => {
    for (const product of SEED_PRODUCTS) {
      for (const variant of product.variants) {
        expect(
          Number.isInteger(variant.price),
          `${product.title} / ${variant.title}: price must be integer centavos, got ${variant.price}`
        ).toBe(true)

        expect(
          variant.price > 0,
          `${product.title} / ${variant.title}: price must be positive, got ${variant.price}`
        ).toBe(true)
      }
    }
  })

  it("prices are within a sane range for a restaurant (R$0.50 – R$500)", () => {
    const MIN_CENTAVOS = 50      // R$0,50
    const MAX_CENTAVOS = 50_000  // R$500,00
    for (const product of SEED_PRODUCTS) {
      for (const variant of product.variants) {
        expect(
          variant.price >= MIN_CENTAVOS && variant.price <= MAX_CENTAVOS,
          `${product.title} / ${variant.title}: price ${variant.price} centavos is outside sane range`
        ).toBe(true)
      }
    }
  })

  it("congelado-tagged products have availabilityWindow: congelados", () => {
    const congelados = SEED_PRODUCTS.filter((p) => p.tags.includes("congelado"))
    expect(congelados.length, "Expected at least one congelado product").toBeGreaterThan(0)
    for (const product of congelados) {
      expect(
        product.metadata.availabilityWindow,
        `${product.title}: congelado products must have availabilityWindow "congelados"`
      ).toBe("congelados")
    }
  })

  it("frozen products have productType: frozen", () => {
    const congelados = SEED_PRODUCTS.filter((p) => p.tags.includes("congelado"))
    for (const product of congelados) {
      expect(
        product.metadata.productType,
        `${product.title}: congelado products must have productType "frozen"`
      ).toBe("frozen")
    }
  })

  it("non-frozen products do not have availabilityWindow: congelados", () => {
    const nonFrozen = SEED_PRODUCTS.filter((p) => !p.tags.includes("congelado"))
    for (const product of nonFrozen) {
      expect(
        product.metadata.availabilityWindow,
        `${product.title}: non-frozen product must not have availabilityWindow "congelados"`
      ).not.toBe("congelados")
    }
  })

  it("every product has at least one variant", () => {
    for (const product of SEED_PRODUCTS) {
      expect(
        product.variants.length,
        `${product.title}: must have at least one variant`
      ).toBeGreaterThan(0)
    }
  })

  it("every variant has a non-empty title", () => {
    for (const product of SEED_PRODUCTS) {
      for (const variant of product.variants) {
        expect(
          variant.title.trim().length,
          `${product.title}: variant title must not be empty`
        ).toBeGreaterThan(0)
      }
    }
  })

  it("all product handles are lowercase kebab-case with no special chars", () => {
    for (const product of SEED_PRODUCTS) {
      expect(
        KEBAB_REGEX.test(product.handle),
        `${product.title}: handle "${product.handle}" is not valid kebab-case`
      ).toBe(true)
    }
  })

  it("all product titles are non-empty", () => {
    for (const product of SEED_PRODUCTS) {
      expect(
        product.title.trim().length,
        `Product with handle "${product.handle}" has empty title`
      ).toBeGreaterThan(0)
    }
  })

  it("all product descriptions are non-empty", () => {
    for (const product of SEED_PRODUCTS) {
      expect(
        product.description.trim().length,
        `${product.title}: description must not be empty`
      ).toBeGreaterThan(0)
    }
  })

  it("nutritionalInfo fields are all non-negative numbers", () => {
    for (const product of SEED_PRODUCTS) {
      for (const field of NUTRITIONAL_FIELDS) {
        const val = product.metadata.nutritionalInfo[field]
        expect(
          typeof val === "number" && val >= 0,
          `${product.title}: nutritionalInfo.${field} must be a non-negative number, got ${val}`
        ).toBe(true)
      }
    }
  })

  it("no duplicate product handles", () => {
    const handles = SEED_PRODUCTS.map((p) => p.handle)
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const h of handles) {
      if (seen.has(h)) duplicates.push(h)
      seen.add(h)
    }
    expect(
      duplicates.length,
      `Duplicate handles found: ${duplicates.join(", ")}`
    ).toBe(0)
  })

  it("no duplicate product titles", () => {
    const titles = SEED_PRODUCTS.map((p) => p.title)
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const t of titles) {
      if (seen.has(t)) duplicates.push(t)
      seen.add(t)
    }
    expect(
      duplicates.length,
      `Duplicate titles found: ${duplicates.join(", ")}`
    ).toBe(0)
  })

  it("all products use tags from the allowed tag list", () => {
    for (const product of SEED_PRODUCTS) {
      for (const tag of product.tags) {
        expect(
          (VALID_TAGS as readonly string[]).includes(tag),
          `${product.title}: tag "${tag}" is not in the allowed tag list`
        ).toBe(true)
      }
    }
  })
})

// ── Cross-reference: products ↔ categories ────────────────────────────────────

describe("Category cross-references", () => {
  const categoryHandles = new Set(CATEGORIES.map((c) => c.handle))

  it("all products reference an existing category handle", () => {
    for (const product of SEED_PRODUCTS) {
      expect(
        categoryHandles.has(product.categoryHandle),
        `${product.title}: categoryHandle "${product.categoryHandle}" does not exist in CATEGORIES`
      ).toBe(true)
    }
  })

  it("every non-root category has at least one product", () => {
    const usedCategories = new Set(SEED_PRODUCTS.map((p) => p.categoryHandle))
    const nonRootCategories = CATEGORIES.filter((c) => c.parent !== null)
    for (const cat of nonRootCategories) {
      expect(
        usedCategories.has(cat.handle),
        `Category "${cat.handle}" has no products — either add products or remove the category`
      ).toBe(true)
    }
  })
})

// ── Dataset completeness ──────────────────────────────────────────────────────

describe("Dataset completeness", () => {
  it("has at least 20 products", () => {
    expect(
      SEED_PRODUCTS.length,
      `Expected at least 20 products, got ${SEED_PRODUCTS.length}`
    ).toBeGreaterThanOrEqual(20)
  })

  it("has at least one product in each non-root category", () => {
    const nonRoots = CATEGORIES.filter((c) => c.parent !== null).map((c) => c.handle)
    const used = new Set(SEED_PRODUCTS.map((p) => p.categoryHandle))
    for (const cat of nonRoots) {
      expect(used.has(cat), `No products in category "${cat}"`).toBe(true)
    }
  })

  it("has at least one frozen product", () => {
    const frozen = SEED_PRODUCTS.filter((p) => p.metadata.productType === "frozen")
    expect(frozen.length, "Expected at least one frozen product").toBeGreaterThan(0)
  })

  it("has at least one product tagged popular or chef_choice", () => {
    const featured = SEED_PRODUCTS.filter(
      (p) => p.tags.includes("popular") || p.tags.includes("chef_choice")
    )
    expect(
      featured.length,
      "Expected at least one featured product (popular or chef_choice)"
    ).toBeGreaterThan(0)
  })
})
