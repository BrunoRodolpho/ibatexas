// Shared product mappers — single source of truth for all data transformations
//
// Three transformations, three functions:
//   medusaToTypesenseDoc  →  used during indexing (Medusa API → Typesense document)
//   typesenseDocToDTO     →  used during search   (Typesense document → ProductDTO)
//
// Never mix these — Typesense documents have flat fields;
// Medusa objects have nested variants/prices/metadata.

import type { ProductDTO, ProductVariant } from "@ibatexas/types"

// ── Input types ─────────────────────────────────────────────────────────────

/** Medusa product shape used during indexing.
 *  Supports both admin API (snake_case) and product module (mixed) shapes.
 *  Tags come as objects `{ id, value }` from retrieval, or as `tag_ids` strings.
 */
export interface MedusaProductInput {
  id: string
  title: string
  description?: string | null
  thumbnail?: string | null
  images?: Array<{ id: string; url: string; rank?: number }>
  status?: string
  // Medusa v2 returns tags as objects on retrieval
  tags?: Array<{ id: string; value: string }> | string[]
  // tag_ids only exists on create/update payloads
  tag_ids?: string[]
  // categories from Medusa v2 product retrieval
  categories?: Array<{ id: string; handle?: string; name?: string }>
  variants?: Array<{
    id?: string
    title: string
    sku?: string | null
    // Direct prices (admin API with expand)
    prices?: Array<{ amount: number; currency_code: string }>
    // Medusa v2 calculated price (store API)
    calculated_price?: { calculated_amount?: number }
    // Medusa v2 price set link
    price_set?: { id: string; prices?: Array<{ amount: number; currency_code: string }> }
  }>
  metadata?: Record<string, unknown>
  created_at?: string
  updated_at?: string
  // Medusa module objects use camelCase
  createdAt?: string
  updatedAt?: string
}

/** Typesense document shape returned from search results. */
export interface TypesenseProductDoc {
  id: string
  title: string
  description?: string
  price?: number
  imageUrl?: string | null
  images?: string[]
  tags?: string[]
  availabilityWindow?: string
  allergens?: string[]
  productType?: string
  categoryHandle?: string
  status?: string
  inStock?: boolean
  /** JSON-serialized ProductVariant[] — parsed back in typesenseDocToDTO */
  variantsJson?: string
  preparationTimeMinutes?: number | null
  rating?: number | null
  reviewCount?: number | null
  createdAt?: string
  updatedAt?: string
  createdAtTimestamp?: number
  embedding?: number[]
}

/**
 * Convert a Medusa product object to a Typesense document for indexing.
 * Medusa products have nested structure (variants → prices → amount).
 */
export function medusaToTypesenseDoc(product: MedusaProductInput): TypesenseProductDoc {
  // Extract tags: handle both object array `[{ id, value }]` and string array
  const tags = extractTags(product)

  // Extract all variant prices and serialize to JSON for Typesense storage
  const variants = extractVariants(product)

  // Price = lowest variant price ("a partir de") for list views; 0 if no variants
  const price = variants.length > 0
    ? Math.min(...variants.map((v) => v.price))
    : extractPrice(product)

  // Extract category handle: try categories array first, then metadata
  const categoryHandle = extractCategoryHandle(product)

  const createdAt = product.created_at || product.createdAt || ""
  const updatedAt = product.updated_at || product.updatedAt || ""

  // Extract images: sort by rank, map to URLs
  const images = extractImages(product)

  return {
    id: product.id,
    title: product.title,
    description: product.description || "",
    price,
    imageUrl: product.thumbnail || null,
    images,
    tags,
    availabilityWindow: (product.metadata?.availabilityWindow as string) || "sempre",
    allergens: Array.isArray(product.metadata?.allergens) ? product.metadata.allergens as string[] : [],
    productType: (product.metadata?.productType as string) || "food",
    categoryHandle,
    status: product.status || "published",
    inStock: product.metadata?.inStock !== false, // true unless explicitly false
    variantsJson: variants.length > 0 ? JSON.stringify(variants) : undefined,
    preparationTimeMinutes: (product.metadata?.preparationTimeMinutes as number) || null,
    rating: (product.metadata?.rating as number) || null,
    reviewCount: (product.metadata?.reviewCount as number) || null,
    createdAt,
    updatedAt,
    createdAtTimestamp: createdAt ? new Date(createdAt).getTime() : Date.now(),
    // embedding: set by caller (indexProduct) after generation
  }
}

/** Extract tag values from Medusa product.
 *  Handles: `tags: [{ id, value }]` (retrieval), `tag_ids: ["str"]` (creation), or `tags: ["str"]`.
 */
function extractTags(product: MedusaProductInput): string[] {
  if (Array.isArray(product.tags) && product.tags.length > 0) {
    const first = product.tags[0]
    if (typeof first === "string") return product.tags as string[]
    if (typeof first === "object" && "value" in first) {
      return (product.tags as Array<{ value: string }>).map((t) => t.value)
    }
  }
  if (Array.isArray(product.tag_ids) && product.tag_ids.length > 0) {
    return product.tag_ids
  }
  return []
}

/** Extract all variants with their prices from a Medusa product.
 *  Returns ProductVariant[] with prices in centavos.
 *  Medusa v2 stores amounts in main currency unit (reais). We convert to centavos
 *  (integer) to match our internal convention (CLAUDE.md: 8900 = R$89,00).
 */
function extractVariants(product: MedusaProductInput): ProductVariant[] {
  if (!product.variants || product.variants.length === 0) return []

  return product.variants.map((variant) => {
    const price = extractVariantPrice(variant)
    return {
      id: variant.id || "",
      title: variant.title || null,
      sku: variant.sku ?? null,
      price,
    }
  })
}

/** Extract price (in centavos) from a single Medusa variant.
 *  Tries: variant.prices → variant.calculated_price → variant.price_set.prices
 *  Prefers BRL currency when multiple currencies exist.
 */
function extractVariantPrice(variant: NonNullable<MedusaProductInput["variants"]>[number]): number {
  let amount = 0

  // Direct prices (admin API with expand) — prefer BRL
  if (variant.prices && variant.prices.length > 0) {
    const brl = variant.prices.find((p) => p.currency_code === "brl")
    amount = brl?.amount ?? variant.prices[0].amount
  }
  // Calculated price (store API)
  else if (variant.calculated_price?.calculated_amount) {
    amount = variant.calculated_price.calculated_amount
  }
  // Price set link
  else if (variant.price_set?.prices && variant.price_set.prices.length > 0) {
    const brl = variant.price_set.prices.find((p) => p.currency_code === "brl")
    amount = brl?.amount ?? variant.price_set.prices[0].amount
  }

  // Convert reais → centavos (round to avoid floating point issues)
  return Math.round(amount * 100)
}

/** Extract best price from first variant (legacy fallback when extractVariants is empty).
 *  Used only when product has no variant data at all.
 */
function extractPrice(product: MedusaProductInput): number {
  const variant = product.variants?.[0]
  if (!variant) return 0
  return extractVariantPrice(variant)
}

/** Extract image URLs from Medusa product images, sorted by rank.
 *  If thumbnail exists but isn't in images[], it's prepended.
 */
function extractImages(product: MedusaProductInput): string[] {
  const imgs = [...(product.images || [])]
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((img) => img.url)

  // Ensure thumbnail is in the list (prepend if missing)
  if (product.thumbnail && !imgs.includes(product.thumbnail)) {
    imgs.unshift(product.thumbnail)
  }

  return imgs
}

/** Extract category handle: prefer categories array, fallback to metadata. */
function extractCategoryHandle(product: MedusaProductInput): string | undefined {
  if (Array.isArray(product.categories) && product.categories.length > 0) {
    // Pick first non-root category (child category is more specific)
    const cat = product.categories.find((c) => c.handle && c.handle !== "restaurante" && c.handle !== "loja")
      || product.categories[0]
    if (cat?.handle) return cat.handle
  }
  return (product.metadata?.categoryHandle as string) || undefined
}

/**
 * Convert a Typesense search result document to ProductDTO.
 * Typesense documents are flat — do NOT use medusaToTypesenseDoc paths here.
 */
export function typesenseDocToDTO(doc: TypesenseProductDoc): ProductDTO {
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description || "",
    price: typeof doc.price === "number" ? doc.price : 0,
    imageUrl: doc.imageUrl || null,
    images: Array.isArray(doc.images) ? doc.images : [],
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    availabilityWindow: (doc.availabilityWindow || "sempre") as ProductDTO["availabilityWindow"],
    allergens: Array.isArray(doc.allergens) ? doc.allergens : [],
    variants: parseVariantsJson(doc.variantsJson),
    productType: (doc.productType || "food") as ProductDTO["productType"],
    categoryHandle: doc.categoryHandle || undefined,
    status: (doc.status || "published") as ProductDTO["status"],
    inStock: doc.inStock !== false,
    preparationTimeMinutes: doc.preparationTimeMinutes ?? undefined,
    rating: doc.rating ?? undefined,
    reviewCount: doc.reviewCount ?? undefined,
    createdAt: doc.createdAt ?? "",
    updatedAt: doc.updatedAt ?? "",
  }
}

/** Safely parse variantsJson string back to ProductVariant[].
 *  Returns [] on missing/invalid data (never throws).
 */
function parseVariantsJson(json?: string): ProductVariant[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.map((v: Record<string, unknown>) => ({
      id: (v.id as string) || "",
      title: (v.title as string) ?? null,
      sku: (v.sku as string) ?? null,
      price: typeof v.price === "number" ? v.price : 0,
    }))
  } catch {
    return []
  }
}
