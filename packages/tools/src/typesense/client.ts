// Typesense client wrapper
// Manages connection, schema, and collections

import { Client } from "typesense"
import { EMBED_DIM } from "../config.js"

/** Collection name — allows test isolation and multi-tenant deployments */
export const COLLECTION = process.env.TYPESENSE_COLLECTION_NAME || "products"

let client: Client | null = null

export function getTypesenseClient(): Client {
  if (!client) {
    const host = process.env.TYPESENSE_HOST
    const port = Number.parseInt(process.env.TYPESENSE_PORT || "8108", 10)
    const apiKey = process.env.TYPESENSE_API_KEY

    if (!host || !apiKey) {
      throw new Error("TYPESENSE_HOST and TYPESENSE_API_KEY env vars required")
    }

    client = new Client({
      nodes: [{ host, port, protocol: process.env.TYPESENSE_PROTOCOL || "http" }],
      apiKey,
      connectionTimeoutSeconds: Number.parseInt(process.env.TYPESENSE_TIMEOUT_SECONDS || "10", 10),
    })
  }

  return client
}

/**
 * Typesense collection schema for products.
 *
 * Field notes:
 * - price: integer centavos (e.g. 8900 = R$89,00)
 * - allergens: always explicit string[], never null (CLAUDE.md rule)
 * - status: "published" | "draft" — search filters to published only
 * - inStock: false when admin marks item unavailable (metadata.inStock = false)
 * - createdAtTimestamp: Unix epoch ms — numeric field for sort (default_sorting_field must be numeric)
 * - embedding: 1536-dim from text-embedding-3-small; requires Typesense v0.25+
 */
export const PRODUCTS_COLLECTION_SCHEMA = {
  name: COLLECTION,
  fields: [
    { name: "id", type: "string" },
    { name: "title", type: "string", facet: false },
    { name: "description", type: "string" },
    { name: "price", type: "int64" },
    { name: "imageUrl", type: "string", optional: true },
    { name: "images", type: "string[]", optional: true },
    { name: "tags", type: "string[]", facet: true },
    { name: "availabilityWindow", type: "string", facet: true },
    { name: "allergens", type: "string[]", facet: true },
    { name: "productType", type: "string", facet: true },
    { name: "categoryHandle", type: "string", facet: true, optional: true },
    { name: "status", type: "string", facet: true },
    { name: "inStock", type: "bool" },
    { name: "variantsJson", type: "string", optional: true },
    { name: "preparationTimeMinutes", type: "int32", optional: true },
    { name: "rating", type: "float", optional: true },
    { name: "reviewCount", type: "int32", optional: true },
    { name: "createdAt", type: "string" },
    { name: "updatedAt", type: "string" },
    { name: "createdAtTimestamp", type: "int64" },
    // Vector field — requires Typesense v0.25+
    { name: "embedding", type: "float[]", optional: true, num_dim: EMBED_DIM },
  ],
  default_sorting_field: "createdAtTimestamp",
}

/**
 * Ensure products collection exists; create if missing.
 * Idempotent.
 */
export async function ensureCollectionExists(): Promise<void> {
  const typesenseClient = getTypesenseClient()

  try {
    await typesenseClient.collections(COLLECTION).retrieve()
    // Collection exists
  } catch (error: any) {
    if (error.httpStatus === 404) {
      // Collection doesn't exist; create it
      await typesenseClient.collections().create(PRODUCTS_COLLECTION_SCHEMA as any)
      console.log(`[Typesense] Created ${COLLECTION} collection`)
    } else {
      throw error
    }
  }
}

/**
 * Delete and recreate products collection (full reindex).
 */
export async function recreateCollection(): Promise<void> {
  const typesenseClient = getTypesenseClient()

  try {
    await typesenseClient.collections(COLLECTION).delete()
  } catch (error: any) {
    if (error.httpStatus !== 404) {
      throw error
    }
    // Already deleted
  }

  await ensureCollectionExists()
  console.log(`[Typesense] Recreated ${COLLECTION} collection`)
}
