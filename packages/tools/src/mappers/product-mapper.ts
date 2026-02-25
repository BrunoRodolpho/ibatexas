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

/** Medusa product shape used during indexing. */
export interface MedusaProductInput {
  id: string
  title: string
  description?: string | null
  thumbnail?: string | null
  status?: string
  tag_ids?: string[]
  variants?: Array<{
    title: string
    sku?: string | null
    prices?: Array<{ amount: number; currency_code: string }>
  }>
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** Typesense document shape returned from search results. */
export interface TypesenseProductDoc {
  id: string
  title: string
  description?: string
  price?: number
  imageUrl?: string | null
  tags?: string[]
  availabilityWindow?: string
  allergens?: string[]
  productType?: string
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
  return {
    id: product.id,
    title: product.title,
    description: product.description || "",
    price: product.variants?.[0]?.prices?.[0]?.amount || 0, // centavos
    imageUrl: product.thumbnail || null,
    tags: product.tag_ids || [],
    availabilityWindow: (product.metadata?.availabilityWindow as string) || "sempre",
    allergens: Array.isArray(product.metadata?.allergens) ? product.metadata.allergens as string[] : [],
    productType: (product.metadata?.productType as string) || "food",
    status: product.status || "published",
    inStock: product.metadata?.inStock !== false, // true unless explicitly false
    preparationTimeMinutes: (product.metadata?.preparationTimeMinutes as number) || null,
    rating: (product.metadata?.rating as number) || null,
    reviewCount: (product.metadata?.reviewCount as number) || null,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
    createdAtTimestamp: new Date(product.created_at).getTime(), // numeric for sorting
    // embedding: set by caller (indexProduct) after generation
  }
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
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    availabilityWindow: (doc.availabilityWindow || "sempre") as ProductDTO["availabilityWindow"],
    allergens: Array.isArray(doc.allergens) ? doc.allergens : [],
    variants: [], // Typesense does not store variant detail; fetch from Medusa if needed
    productType: (doc.productType || "food") as ProductDTO["productType"],
    status: (doc.status || "published") as ProductDTO["status"],
    inStock: doc.inStock !== false,
    preparationTimeMinutes: doc.preparationTimeMinutes ?? undefined,
    rating: doc.rating ?? undefined,
    reviewCount: doc.reviewCount ?? undefined,
    createdAt: doc.createdAt ?? "",
    updatedAt: doc.updatedAt ?? "",
  }
}
