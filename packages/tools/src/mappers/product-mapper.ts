// Shared product mappers — single source of truth for all data transformations
//
// Three transformations, three functions:
//   medusaToTypesenseDoc  →  used during indexing (Medusa API → Typesense document)
//   typesenseDocToDTO     →  used during search   (Typesense document → ProductDTO)
//
// Never mix these — Typesense documents have flat fields;
// Medusa objects have nested variants/prices/metadata.

import type { ProductDTO } from "@ibatexas/types"

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

  // Extract price: try multiple Medusa v2 paths
  const price = extractPrice(product)

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

/** Extract best price from Medusa v2 product variants.
 *  Tries: variant.prices[0].amount → variant.calculated_price → variant.price_set.prices[0].amount
 */
function extractPrice(product: MedusaProductInput): number {
  const variant = product.variants?.[0]
  if (!variant) return 0

  // Direct prices (admin API with expand)
  if (variant.prices?.[0]?.amount) return variant.prices[0].amount

  // Calculated price (store API)
  if (variant.calculated_price?.calculated_amount) return variant.calculated_price.calculated_amount

  // Price set link
  if (variant.price_set?.prices?.[0]?.amount) return variant.price_set.prices[0].amount

  return 0
}

/** Extract image URLs from Medusa product images, sorted by rank.
 *  If thumbnail exists but isn't in images[], it's prepended.
 */
function extractImages(product: MedusaProductInput): string[] {
  const imgs = (product.images || [])
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
    variants: [], // Typesense does not store variant detail; fetch from Medusa if needed
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
