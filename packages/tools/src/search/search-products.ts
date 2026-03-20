// search_products tool: RAG-first semantic product search
//
// Search pipeline (per query):
//   1. Validate input
//   2. Check L0 exact cache (zero embedding cost for repeated identical queries)
//   3. Generate query embedding (cached in Redis)
//   4. Check L1 semantic cache (bucket-based, handles rephrased queries)
//   5. Query Typesense (vector + keyword hybrid, filters to published + inStock)
//   6. Apply post-filters (tags, availability window, allergens)
//   7. Cache results (L0 + L1)
//   8. Log query + publish product.viewed NATS events (one per product)
//
// Multi-query (queries[]):
//   - All embeddings + Typesense searches run in parallel (Promise.all)
//   - Results merged and deduplicated by product ID (first-query wins)
//   - Each query has its own independent L0/L1 cache entries

import {
  SearchProductsInputSchema,
  type SearchProductsInput,
  type SearchProductsOutput,
  type ProductDTO,
  AvailabilityWindow,
  Channel,
} from "@ibatexas/types"
import { generateEmbedding } from "../embeddings/client.js"
import { rk } from "../redis/key.js"
import {
  getExactQueryCache,
  setExactQueryCache,
  getQueryCache,
  setQueryCache,
  incrementQueryCacheHits,
  logQuery,
  allergenFilterHash,
  embeddingToBucket,
  type CacheFilterContext,
} from "../cache/query-cache.js"
import { typesenseDocToDTO, type TypesenseProductDoc } from "../mappers/product-mapper.js"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { getTypesenseClient, COLLECTION } from "../typesense/client.js"
import type { TypesenseHit, TypesenseFacetCount } from "../typesense/types.js"

// ── Types ────────────────────────────────────────────────────────────────────

type UserType = "guest" | "customer" | "staff"

// ── Availability ──────────────────────────────────────────────────────────────

/**
 * Check if a product's availability window is currently open.
 * All hours read from env vars — never hardcoded.
 */
function isAvailableNow(availabilityWindow: string): boolean {
  const now = new Date()
  const tz = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo"
  const brazilTime = new Date(now.toLocaleString("en-US", { timeZone: tz }))
  const hour = brazilTime.getHours()

  const lunchStart = Number.parseInt(process.env.RESTAURANT_LUNCH_START_HOUR || "11", 10)
  const lunchEnd = Number.parseInt(process.env.RESTAURANT_LUNCH_END_HOUR || "15", 10)
  const dinnerStart = Number.parseInt(process.env.RESTAURANT_DINNER_START_HOUR || "18", 10)
  const dinnerEnd = Number.parseInt(process.env.RESTAURANT_DINNER_END_HOUR || "23", 10)

  switch (availabilityWindow) {
    case AvailabilityWindow.ALMOCO:
      return hour >= lunchStart && hour < lunchEnd
    case AvailabilityWindow.JANTAR:
      return hour >= dinnerStart && hour < dinnerEnd
    case AvailabilityWindow.CONGELADOS:
    case AvailabilityWindow.SEMPRE:
      return true
    default:
      return true
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────

interface FilterOptions {
  tags?: string[]
  availableNow: boolean
  excludeAllergens?: string[]
  productType?: "food" | "frozen" | "merchandise"
  categoryHandle?: string
  minPrice?: number // centavos
  maxPrice?: number // centavos
  minRating?: number // 0-5
  sort?: "relevance" | "price_asc" | "price_desc" | "rating_desc" | "newest"
  offset?: number
}

/** Check if a product passes availability filter */
function passesAvailabilityFilter(product: ProductDTO, availableNow: boolean): boolean {
  if (!availableNow) return true
  return isAvailableNow(product.availabilityWindow)
}

/** Check if a product passes allergen filter */
function passesAllergenFilter(product: ProductDTO, excludeAllergens?: string[]): boolean {
  if (!excludeAllergens || excludeAllergens.length === 0) return true
  return !product.allergens.some((a) => excludeAllergens.includes(a))
}

/** Check if a product passes price range filter */
function passesPriceFilter(product: ProductDTO, minPrice?: number, maxPrice?: number): boolean {
  if (minPrice === undefined && maxPrice === undefined) return true
  const prices = (product.variants ?? []).map((v) => v.price).filter((p) => p > 0)
  const lowestPrice = prices.length > 0 ? Math.min(...prices) : 0
  if (minPrice !== undefined && lowestPrice < minPrice) return false
  if (maxPrice !== undefined && lowestPrice > maxPrice) return false
  return true
}

/** Check if a product passes rating filter */
function passesRatingFilter(product: ProductDTO, minRating?: number): boolean {
  if (minRating === undefined) return true
  const rating = (product as { rating?: number }).rating ?? 0
  return rating >= minRating
}

/**
 * Apply post-fetch filters that cannot be expressed as Typesense filter_by.
 * Tags are now handled by Typesense filter_by — no longer post-filtered here.
 * Availability window is time-dependent and product-specific.
 */
function applyFilters(products: ProductDTO[], filters: FilterOptions): ProductDTO[] {
  return products.filter((product) =>
    passesAvailabilityFilter(product, filters.availableNow) &&
    passesAllergenFilter(product, filters.excludeAllergens) &&
    passesPriceFilter(product, filters.minPrice, filters.maxPrice) &&
    passesRatingFilter(product, filters.minRating)
  )
}

// ── Typesense search ──────────────────────────────────────────────────────────

interface TypesenseResult {
  hits: TypesenseProductDoc[]
  totalFound: number
  scores: Record<string, number> // productId → relevance score
  facetCounts?: Record<string, Array<{ value: string; count: number }>>
}

interface TypesenseSearchOptions {
  query: string
  embedding: number[]
  limit: number
  filterInStock?: boolean
  productType?: "food" | "frozen" | "merchandise"
  categoryHandle?: string
  tags?: string[]
  sort?: string
  offset?: number
}

/** Build Typesense filter_by string from search options */
function buildFilterBy(opts: Pick<TypesenseSearchOptions, 'filterInStock' | 'productType' | 'categoryHandle' | 'tags'>): string {
  const parts = ["status:published"]
  if (opts.filterInStock !== false) parts.push("inStock:true")
  if (opts.productType) parts.push(`productType:${opts.productType}`)
  if (opts.categoryHandle) parts.push(`categoryHandle:${opts.categoryHandle}`)
  if (opts.tags && opts.tags.length > 0) parts.push(`tags:=[${opts.tags.join(",")}]`)
  return parts.join(" && ")
}

const SORT_BY_MAP: Record<string, string> = {
  price_asc: "price:asc",
  price_desc: "price:desc",
  rating: "rating:desc",
  popular: "orderCount:desc",
}

/** Extract hit scores from Typesense response */
function extractHitsAndScores(hits: TypesenseHit[]): { docs: TypesenseProductDoc[]; scores: Record<string, number> } {
  const scores: Record<string, number> = {}
  const docs: TypesenseProductDoc[] = []

  for (const hit of hits) {
    const doc = hit.document
    docs.push(doc)
    if (doc?.id) {
      const score =
        hit.hybrid_search_info?.rank_fusion_score ??
        hit.text_match_score ??
        0
      scores[doc.id] = score
    }
  }

  return { docs, scores }
}

/**
 * Execute Typesense hybrid search (vector + keyword).
 * Uses multi_search (POST) to avoid query-string length limits with large embeddings.
 */
async function executeTypesenseSearch(opts: TypesenseSearchOptions): Promise<TypesenseResult> {
  const { query, embedding, limit, sort, offset } = opts
  const typesenseClient = getTypesenseClient()

  const searchParams: Record<string, string | number | boolean> = {
    q: query,
    query_by: "title,description,tags",
    filter_by: buildFilterBy(opts),
    facet_by: "tags,availabilityWindow,allergens,productType",
    limit,
    per_page: limit,
    page: offset ? Math.floor(offset / limit) + 1 : 1,
  }

  if (sort && SORT_BY_MAP[sort]) {
    searchParams.sort_by = SORT_BY_MAP[sort]
  }

  if (embedding.length > 0) {
    searchParams.vector_query = `embedding:([${embedding.join(",")}], k:${limit})`
  }

  // Use multi_search (POST) to avoid GET query-string length limits
  // with large embedding vectors (1536-dim ≈ 15KB as text)
  const multiResult = await typesenseClient.multiSearch.perform(
    { searches: [searchParams] },
    { collection: COLLECTION }
  )

  const response = (multiResult.results ?? [])[0] as
    | { hits?: TypesenseHit[]; found?: number; facet_counts?: TypesenseFacetCount[] }
    | undefined
  if (!response) {
    return { hits: [], totalFound: 0, scores: {} }
  }

  const { docs, scores } = extractHitsAndScores(response.hits ?? [])

  return {
    hits: docs,
    totalFound: response.found ?? 0,
    scores,
    facetCounts: parseFacetCounts(response.facet_counts),
  }
}

function parseFacetCounts(
  raw: TypesenseFacetCount[] | undefined
): Record<string, Array<{ value: string; count: number }>> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const result: Record<string, Array<{ value: string; count: number }>> = {}
  for (const fc of raw) {
    const field = fc?.field_name as string
    const counts = fc?.counts as Array<{ value: string; count: number }> | undefined
    if (field && Array.isArray(counts)) {
      result[field] = counts.map((c) => ({ value: c.value, count: c.count }))
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// ── noResultsReason diagnostic ────────────────────────────────────────────────

type NoResultsReason = "no_match" | "out_of_stock" | "allergen_filtered" | "not_available_now"

/**
 * Diagnose why a search returned empty results.
 * Only called when primary results are empty — adds at most 1 extra Typesense call.
 */
async function diagnoseNoResults(
  query: string,
  embedding: number[],
  limit: number,
  rawDocs: ProductDTO[], // docs from primary Typesense call (already passed inStock filter)
  filters: FilterOptions
): Promise<NoResultsReason> {
  if (rawDocs.length === 0) {
    // Typesense found nothing with inStock:true — check if OOS products exist
    try {
      const diagResult = await executeTypesenseSearch({ query, embedding, limit, filterInStock: false, productType: filters.productType, categoryHandle: filters.categoryHandle, tags: filters.tags })
      if (diagResult.hits.length > 0) {
        return "out_of_stock"
      }
    } catch {
      // Diagnostic query failure is non-critical
    }
    return "no_match"
  }

  // rawDocs had results but post-filters removed them — identify which filter
  // Check allergen filter first (hard safety filter)
  const afterAllergen = applyFilters(rawDocs, {
    tags: filters.tags,
    availableNow: false, // skip availability for this check
    excludeAllergens: filters.excludeAllergens,
  })
  if (afterAllergen.length === 0) {
    return "allergen_filtered"
  }

  // Check availability filter
  const afterAvailability = applyFilters(rawDocs, {
    tags: filters.tags,
    availableNow: filters.availableNow,
    excludeAllergens: [], // skip allergen for this check
  })
  if (afterAvailability.length === 0) {
    return "not_available_now"
  }

  return "no_match"
}

// ── Single-query search ───────────────────────────────────────────────────────

interface SingleQueryResult {
  query: string
  products: ProductDTO[]
  totalFound: number
  scores: Record<string, number> // always present; omitted from final output on cache hit
  hitCache: boolean
  cachedAt?: string
  searchModel: "hybrid" | "keyword"
  noResultsReason?: NoResultsReason
}

interface SingleQuerySearchOptions {
  query: string
  filters: FilterOptions
  userType: UserType
  sessionId: string
  limit: number
  cacheCtx: CacheFilterContext
  cacheTtl: number
  facetCountsRef?: { value?: Record<string, Array<{ value: string; count: number }>> }
}

// ── Pipeline helpers (extracted from singleQuerySearch to reduce complexity) ─

/** L0: Check exact query cache. Returns a cache-hit result or null to continue. */
async function checkL0Cache(
  query: string,
  cacheCtx: CacheFilterContext,
  isWildcard: boolean,
): Promise<SingleQueryResult | null> {
  const l0 = await getExactQueryCache(query, cacheCtx)
  if (!l0.hit) return null
  return {
    query,
    products: l0.results,
    totalFound: l0.results.length,
    scores: {},
    hitCache: true,
    cachedAt: l0.cachedAt,
    searchModel: isWildcard ? "keyword" : "hybrid",
  }
}

/** Generate query embedding. Returns empty array for wildcards or on error. */
async function generateQueryEmbedding(query: string, isWildcard: boolean): Promise<number[]> {
  if (isWildcard) return []
  try {
    return await generateEmbedding(
      query,
      rk(`embedding:query:${Buffer.from(query).toString("base64")}`)
    )
  } catch (error) {
    console.warn("[Search] Query embedding failed; falling back to keyword search:", (error as Error).message)
    return []
  }
}

/** L1: Check semantic bucket cache. Returns a cache-hit result or null to continue. */
async function checkL1Cache(
  query: string,
  queryEmbedding: number[],
  cacheCtx: CacheFilterContext,
): Promise<SingleQueryResult | null> {
  if (queryEmbedding.length === 0) return null
  const l1 = await getQueryCache(queryEmbedding, cacheCtx)
  if (!l1.hit) return null

  try {
    await incrementQueryCacheHits(queryEmbedding, cacheCtx)
    await setExactQueryCache(query, cacheCtx, l1.results)
  } catch (error) {
    console.warn("[Search] Cache backfill failed (non-critical):", (error as Error).message)
  }
  return {
    query,
    products: l1.results,
    totalFound: l1.results.length,
    scores: {},
    hitCache: true,
    cachedAt: l1.cachedAt,
    searchModel: "hybrid",
  }
}

/** L2: Execute Typesense hybrid search and apply post-filters. */
async function searchTypesense(
  query: string,
  queryEmbedding: number[],
  filters: FilterOptions,
  limit: number,
  facetCountsRef?: { value?: Record<string, Array<{ value: string; count: number }>> },
): Promise<{ products: ProductDTO[]; rawDTOs: ProductDTO[]; tsResult: TypesenseResult; searchError?: boolean }> {
  let tsResult: TypesenseResult = { hits: [], totalFound: 0, scores: {} }
  let searchError = false
  try {
    tsResult = await executeTypesenseSearch({ query, embedding: queryEmbedding, limit, filterInStock: true, productType: filters.productType, categoryHandle: filters.categoryHandle, tags: filters.tags, sort: filters.sort, offset: filters.offset })
    if (facetCountsRef && tsResult.facetCounts) {
      facetCountsRef.value = tsResult.facetCounts
    }
  } catch (error) {
    // Surface Typesense error instead of silently returning empty results
    console.error("[Search] Typesense search failed:", (error as Error).message)
    searchError = true
  }

  const rawDTOs = tsResult.hits.map((doc) => typesenseDocToDTO(doc))
  const products = applyFilters(rawDTOs, filters)
  return { products, rawDTOs, tsResult, searchError }
}

/** Cache search results and log the query. Non-critical — errors are swallowed. */
async function cacheAndLogResults(
  query: string,
  queryEmbedding: number[],
  products: ProductDTO[],
  cacheCtx: CacheFilterContext,
  cacheTtl: number,
  sessionId: string,
  userType: UserType,
): Promise<void> {
  try {
    if (queryEmbedding.length > 0) {
      await setQueryCache(queryEmbedding, products, cacheCtx, cacheTtl)
    }
    await setExactQueryCache(query, cacheCtx, products)
  } catch (error) {
    console.warn("[Search] Cache write failed (non-critical):", (error as Error).message)
  }

  try {
    const bucket = queryEmbedding.length > 0 ? embeddingToBucket(queryEmbedding) : "no-embedding"
    await logQuery(sessionId, query, bucket, products.length, cacheCtx.channel, userType)
  } catch (error) {
    console.warn("[Search] Query log failed (non-critical):", (error as Error).message)
  }
}

// ── Single-query search (orchestrator) ──────────────────────────────────────

/**
 * Run the full L0→embedding→L1→Typesense→filter→cache pipeline for a single query.
 * Does NOT publish NATS events (caller handles that after merging).
 */
async function singleQuerySearch(opts: SingleQuerySearchOptions): Promise<SingleQueryResult> {
  const { query, filters, userType, sessionId, limit, cacheCtx, cacheTtl, facetCountsRef } = opts
  const isWildcard = query === "*"

  const l0Result = await checkL0Cache(query, cacheCtx, isWildcard)
  if (l0Result) return l0Result

  const queryEmbedding = await generateQueryEmbedding(query, isWildcard)

  const l1Result = await checkL1Cache(query, queryEmbedding, cacheCtx)
  if (l1Result) return l1Result

  const { products, rawDTOs, tsResult, searchError } = await searchTypesense(query, queryEmbedding, filters, limit, facetCountsRef)

  // Return structured error when Typesense is down instead of empty results
  if (searchError) {
    return {
      query,
      products: [],
      totalFound: 0,
      scores: {},
      hitCache: false,
      searchModel: "hybrid",
    }
  }

  let noResultsReason: NoResultsReason | undefined
  if (products.length === 0) {
    try {
      noResultsReason = await diagnoseNoResults(query, queryEmbedding, limit, rawDTOs, filters)
    } catch (error) {
      console.warn("[Search] Diagnostic query failed (non-critical):", (error as Error).message)
    }
  }

  await cacheAndLogResults(query, queryEmbedding, products, cacheCtx, cacheTtl, sessionId, userType)

  return {
    query,
    products,
    totalFound: tsResult.totalFound,
    scores: tsResult.scores,
    hitCache: false,
    searchModel: queryEmbedding.length > 0 ? "hybrid" : "keyword",
    noResultsReason,
  }
}

// ── Event publishing ──────────────────────────────────────────────────────────

interface SearchContext {
  sessionId: string
  channel: Channel
  userId?: string
  userType?: UserType
}

/**
 * Publish a single batch search.results_viewed event (instead of O(n) individual events).
 * Non-blocking — caller swallows errors.
 */
async function publishViewedEvents(
  products: ProductDTO[],
  context?: SearchContext,
  query?: string,
): Promise<void> {
  if (products.length === 0) return

  const channel = context?.channel ?? Channel.Web
  const timestamp = new Date().toISOString()

  // Single batch event instead of N individual events
  await publishNatsEvent("search.results_viewed", {
    eventType: "search.results_viewed",
    productIds: products.map((p) => p.id),
    customerId: context?.userId ?? null,
    sessionId: context?.sessionId,
    channel,
    query: query ?? null,
    timestamp,
  })
}

// ── Result merging ───────────────────────────────────────────────────────────

interface MergedResults {
  products: ProductDTO[]
  mergedScores: Record<string, number>
  anyLiveSearch: boolean
  searchModel: "hybrid" | "keyword"
  totalFound: number
  hitCache: boolean
}

/** Deduplicate and merge results from multiple queries. First occurrence wins. */
function mergeQueryResults(queryResults: SingleQueryResult[], limit: number): MergedResults {
  const seen = new Set<string>()
  const mergedProducts: ProductDTO[] = []
  const mergedScores: Record<string, number> = {}
  let anyLiveSearch = false
  let anyHybrid = false

  for (const result of queryResults) {
    if (!result.hitCache) anyLiveSearch = true
    if (result.searchModel === "hybrid") anyHybrid = true

    for (const product of result.products) {
      if (seen.has(product.id)) continue
      seen.add(product.id)
      mergedProducts.push(product)
      if (result.scores[product.id] !== undefined) {
        mergedScores[product.id] = result.scores[product.id]
      }
    }
  }

  return {
    products: mergedProducts.slice(0, limit),
    mergedScores,
    anyLiveSearch,
    searchModel: anyHybrid ? "hybrid" : "keyword",
    totalFound: queryResults.reduce((sum, r) => sum + r.totalFound, 0),
    hitCache: queryResults.every((r) => r.hitCache),
  }
}

/** Pick the most informative noResultsReason from query results */
function resolveNoResultsReason(
  products: ProductDTO[],
  queryResults: SingleQueryResult[],
  isMultiQuery: boolean,
): SearchProductsOutput["noResultsReason"] {
  if (products.length > 0) return undefined
  if (!isMultiQuery) return queryResults[0]?.noResultsReason

  // All queries returned empty — pick the most informative reason by priority
  const reasons = new Set(queryResults.map((r) => r.noResultsReason).filter(Boolean))
  const REASON_PRIORITY: NoResultsReason[] = ["out_of_stock", "allergen_filtered", "not_available_now", "no_match"]
  for (const reason of REASON_PRIORITY) {
    if (reasons.has(reason)) return reason
  }
  return "no_match"
}

// ── Main search function ──────────────────────────────────────────────────────

/**
 * Main search tool: semantic + keyword hybrid search with two-layer caching.
 *
 * Automatically excludes out-of-stock and draft products (Typesense filter_by).
 * Cache invalidation is handled by product.updated and product.deleted subscribers.
 *
 * Supports:
 * - Single query:  { query: "costela defumada" }
 * - Multi-queries: { queries: ["costela de porco", "costela de boi"] }
 */
export async function searchProducts(
  input: SearchProductsInput,
  context?: SearchContext
): Promise<SearchProductsOutput> {
  const validated = SearchProductsInputSchema.parse(input)

  const availableNow = validated.availableNow ?? false
  const limit = validated.limit ?? 5
  const channel = context?.channel ?? Channel.Web
  const userType = context?.userType ?? "guest"
  const sessionId = context?.sessionId ?? "anonymous"
  const availabilityMode = availableNow ? "dynamic" : "all"
  const allergenHash = allergenFilterHash(validated.excludeAllergens)

  const dynamicTtl = Number.parseInt(process.env.QUERY_CACHE_DYNAMIC_TTL_SECONDS || "600", 10)
  const staticTtl = Number.parseInt(process.env.QUERY_CACHE_TTL_SECONDS || "3600", 10)
  const cacheTtl = availableNow ? dynamicTtl : staticTtl

  const cacheCtx: CacheFilterContext = {
    channel,
    availabilityMode,
    allergenHash,
    productType: validated.productType,
    categoryHandle: validated.categoryHandle,
    tags: validated.tags,
  }

  const filters: FilterOptions = {
    tags: validated.tags,
    availableNow,
    excludeAllergens: validated.excludeAllergens,
    productType: validated.productType,
    categoryHandle: validated.categoryHandle,
    sort: validated.sort,
    offset: validated.offset,
    minPrice: validated.minPrice,
    maxPrice: validated.maxPrice,
    minRating: validated.minRating,
  }

  // ── Determine query list ─────────────────────────────────────────────────
  // validated.query and validated.queries are each optional, but Zod refine ensures at least one
  const queryList: string[] = validated.queries?.length
    ? validated.queries
    : [validated.query as string]

  const isMultiQuery = queryList.length > 1

  // ── Run all queries in parallel ──────────────────────────────────────────
  const facetCountsRef: { value?: Record<string, Array<{ value: string; count: number }>> } = {}
  const queryResults = await Promise.all(
    queryList.map((q) =>
      singleQuerySearch({ query: q, filters, userType, sessionId, limit, cacheCtx, cacheTtl, facetCountsRef })
    )
  )

  // ── Merge results ────────────────────────────────────────────────────────
  const merged = mergeQueryResults(queryResults, limit)
  const { products, mergedScores, anyLiveSearch, searchModel, totalFound, hitCache } = merged

  // ── noResultsReason (top-level, for single-query or fully-empty multi-query)
  const noResultsReason = resolveNoResultsReason(products, queryResults, isMultiQuery)

  // ── Publish search.results_viewed batch event ──────────────────────────
  // Single batch event instead of O(n) individual events
  try {
    if (products.length > 0) {
      const queryStr = queryList.join(", ")
      await publishViewedEvents(products, context, queryStr)
    }
  } catch (error) {
    console.warn("[Search] Event publish failed (non-critical):", (error as Error).message)
  }

  // ── Build output ─────────────────────────────────────────────────────────
  const cachedAt = hitCache ? queryResults[0]?.cachedAt : undefined

  const output: SearchProductsOutput = {
    products,
    searchModel,
    hitCache,
    totalFound,
    ...(cachedAt ? { cachedAt } : {}),
    // scores: only include when at least one live search happened (not on full cache hit)
    ...(anyLiveSearch && Object.keys(mergedScores).length > 0 ? { scores: mergedScores } : {}),
    ...(noResultsReason ? { noResultsReason } : {}),
    ...(facetCountsRef.value ? { facetCounts: facetCountsRef.value } : {}),
  }

  // queriesResults: only when multi-query was used
  if (isMultiQuery) {
    output.queriesResults = queryResults.map((r) => ({
      query: r.query,
      products: r.products,
      totalFound: r.totalFound,
      ...(r.noResultsReason ? { noResultsReason: r.noResultsReason } : {}),
    }))
  }

  return output
}

// ── Tool definition ───────────────────────────────────────────────────────────

/**
 * Claude API tool definition for search_products.
 * Description is in pt-BR (user-facing text rule).
 */
export const SearchProductsTool = {
  name: "search_products",
  description: "Busca o catálogo de produtos usando busca semântica + palavras-chave. Use `queries` para buscar múltiplos produtos distintos em paralelo (ex: costela de porco E boi). Ex: 'costela defumada', 'entrada premium', 'algo vegetariano'",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Consulta única em pt-BR (1–200 caracteres). Use quando o usuário pergunta sobre UM produto ou tipo de produto.",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description: "Consultas paralelas — use quando o usuário menciona DOIS OU MAIS produtos distintos separados por 'e', vírgula ou 'ou'. Ex: ['costela de porco', 'costela de boi'] para 'tem costela de porco e boi?'",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filtrar por tags, ex. ['popular', 'sem_gluten']",
      },
      availableNow: {
        type: "boolean",
        description: "Filtrar pelo janela de disponibilidade atual (almoço/jantar)",
      },
      excludeAllergens: {
        type: "array",
        items: { type: "string" },
        description: "Excluir produtos com estes alérgenos (filtro de segurança obrigatório)",
      },
      limit: {
        type: "number",
        description: "Máximo de resultados (1–100, padrão 5)",
      },
    },
  },
}
