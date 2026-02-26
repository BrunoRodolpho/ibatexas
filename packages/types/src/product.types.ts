// Product types, schemas, and DTOs for catalog domain

import { z } from "zod"

// ─── Shared type aliases ──────────────────────────────────────────────────

export type UserType = "guest" | "customer" | "staff"
export type ProductStatus = "published" | "draft"

// ─── Enums ────────────────────────────────────────────────────────────────

export enum AvailabilityWindow {
  ALMOCO = "almoco", // 11:00–15:00
  JANTAR = "jantar", // 18:00–23:00
  CONGELADOS = "congelados", // always available
  SEMPRE = "sempre", // always available
}

export enum ProductType {
  FOOD = "food",
  FROZEN = "frozen",
  MERCHANDISE = "merchandise",
}

export enum Channel {
  Web = "web",
  WhatsApp = "whatsapp",
}

// ─── Product DTO ────────────────────────────────────────────────────────

export interface ProductVariant {
  id: string
  title: string | null
  sku: string | null
}

export interface ProductDTO {
  id: string
  title: string
  description: string | null
  price: number // integer centavos (e.g., 8900 = R$89.00)
  imageUrl: string | null
  tags: string[] // e.g., ["popular", "sem_gluten", "vegetariano"]
  availabilityWindow: AvailabilityWindow
  allergens: string[] // always explicit, never undefined (CLAUDE.md rule)
  variants: ProductVariant[]
  productType: ProductType
  categoryHandle?: string // e.g. "carnes-defumadas", "acompanhamentos"
  status?: ProductStatus
  inStock?: boolean // false when admin marks item unavailable (metadata.inStock = false)
  preparationTimeMinutes?: number
  rating?: number // rolling average
  reviewCount?: number
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
}

// ─── Search Input/Output ────────────────────────────────────────────────

export const SearchProductsInputSchema = z
  .object({
    query: z.string().min(1).max(200).optional().describe("Single free-text search in pt-BR"),
    queries: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(5)
      .optional()
      .describe("Multiple parallel searches (e.g. two distinct products in one message)"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    availableNow: z.boolean().optional().describe("Filter by current availability"),
    excludeAllergens: z.array(z.string()).optional().describe("Hard filter: exclude allergens"),
    productType: z.enum(["food", "frozen", "merchandise"]).optional().describe("Filter by product type"),
    categoryHandle: z.string().optional().describe("Filter by category handle e.g. carnes-defumadas"),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .refine((d) => d.query || (d.queries && d.queries.length > 0), {
    message: "Either query or queries must be provided",
  })

export type SearchProductsInput = z.infer<typeof SearchProductsInputSchema>

export interface SearchProductsOutput {
  products: ProductDTO[] // merged / deduped across all queries, filtered
  searchModel: "hybrid" | "keyword"
  hitCache: boolean
  totalFound: number // total in Typesense index matching query (before limit)
  cachedAt?: string
  scores?: Record<string, number> // productId → Typesense relevance score; absent on cache hit
  noResultsReason?: "no_match" | "out_of_stock" | "allergen_filtered" | "not_available_now"
  queriesResults?: Array<{
    // present only when queries[] used
    query: string
    products: ProductDTO[]
    totalFound: number
    noResultsReason?: "no_match" | "out_of_stock" | "allergen_filtered" | "not_available_now"
  }>
}

// ─── Embedding & Cache ────────────────────────────────────────────────

export interface ProductEmbedding {
  productId: string
  embedding: number[] // 1536 dims (model configurable via EMBEDDING_MODEL)
  generatedAt: string
  model: string // read from EMBEDDING_MODEL env var
}

export interface QueryCacheEntry {
  embedding: number[]
  bucket: string // semantic similarity bucket (derived from embedding)
  results: ProductDTO[]
  resultCount: number
  hitCount: number
  cachedAt: string
  expiresAt: string
}

export interface QueryLogEntry {
  sessionId: string
  timestamp: string
  queryText: string
  bucket: string // semantic bucket (replaces full embedding — saves ~50MB/week in Redis)
  resultsCount: number
  channel: Channel
  userType: UserType
}

// ─── Events ────────────────────────────────────────────────────────────

export interface ProductIndexedEvent {
  productId: string
  title: string
  indexed: boolean
  hasEmbedding: boolean
  indexedAt: string
}

export interface ProductViewedEvent {
  eventType: "product.viewed"
  sessionId?: string
  customerId?: string | null
  channel: Channel
  timestamp: string
  metadata: {
    productId: string // one event per product in results
    source: "search"
  }
}
