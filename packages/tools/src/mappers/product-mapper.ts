// Shared product mappers — single source of truth for all data transformations
//
// Three transformations, three functions:
//   medusaToTypesenseDoc  →  used during indexing (Medusa API → Typesense document)
//   typesenseDocToDTO     →  used during search   (Typesense document → ProductDTO)
//
// Never mix these — Typesense documents have flat fields;
// Medusa objects have nested variants/prices/metadata.

import type { ProductDTO } from "@ibatexas/types"

/**
 * Convert a Medusa product object to a Typesense document for indexing.
 * Medusa products have nested structure (variants → prices → amount).
 */
export function medusaToTypesenseDoc(product: any) {
  return {
    id: product.id,
    title: product.title,
    description: product.description || "",
    price: product.variants?.[0]?.prices?.[0]?.amount || 0, // centavos
    imageUrl: product.thumbnail || null,
    tags: product.tag_ids || [],
    availabilityWindow: product.metadata?.availabilityWindow || "sempre",
    allergens: Array.isArray(product.metadata?.allergens) ? product.metadata.allergens : [],
    productType: product.metadata?.productType || "food",
    status: product.status || "published",
    inStock: product.metadata?.inStock !== false, // true unless explicitly false
    preparationTimeMinutes: product.metadata?.preparationTimeMinutes || null,
    rating: product.metadata?.rating || null,
    reviewCount: product.metadata?.reviewCount || null,
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
export function typesenseDocToDTO(doc: any): ProductDTO {
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description || "",
    price: typeof doc.price === "number" ? doc.price : 0,
    imageUrl: doc.imageUrl || null,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    availabilityWindow: doc.availabilityWindow || "sempre",
    allergens: Array.isArray(doc.allergens) ? doc.allergens : [],
    variants: [], // Typesense does not store variant detail; fetch from Medusa if needed
    productType: doc.productType || "food",
    status: doc.status || "published",
    inStock: doc.inStock !== false,
    preparationTimeMinutes: doc.preparationTimeMinutes ?? undefined,
    rating: doc.rating ?? undefined,
    reviewCount: doc.reviewCount ?? undefined,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}
