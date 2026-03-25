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
  price: number // integer centavos (e.g., 8900 = R$89.00)
}

export interface ProductDTO {
  id: string
  title: string
  description: string | null
  price: number // integer centavos (e.g., 8900 = R$89.00)
  imageUrl: string | null
  images: string[] // full gallery URLs, sorted by rank — always explicit array
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
  servings?: number // how many persons a portion serves
  compareAtPrice?: number // original price in centavos, before discount
  stockCount?: number // enables scarcity ribbon ("Últimas 4 unidades!")
  weight?: string // e.g., "500g", "1.2kg"
  woodType?: string // e.g., "Nogueira", "Carvalho" — craft storytelling
  smokeHours?: number // e.g., 12 — craft storytelling
  isBundle?: boolean // enables bundle pricing UI
  bundleServings?: number // bundle-specific servings (different from per-item)
  pitmasterNote?: string // dynamic pitmaster quote per product
  origin?: string // e.g., "Angus selecionado do Texas"
  pairingTip?: string // harmonização suggestion per product
  /** Channel visibility — "all" | "whatsapp" | "web" | "staff". Default: "all" */
  visibility?: string
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
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional().describe("Pagination offset for infinite scroll"),
    sort: z
      .enum(["relevance", "price_asc", "price_desc", "rating_desc", "newest"])
      .optional()
      .describe("Sort order for results"),
    minPrice: z.number().int().min(0).optional().describe("Minimum price in centavos"),
    maxPrice: z.number().int().min(0).optional().describe("Maximum price in centavos"),
    minRating: z.number().min(0).max(5).optional().describe("Minimum average rating (0–5)"),
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
  facetCounts?: Record<string, Array<{ value: string; count: number }>> // from Typesense facets
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
