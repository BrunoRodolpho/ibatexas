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
  type ProductViewedEvent,
} from "@ibatexas/types"
import { generateEmbedding } from "../embeddings/client.js"
import {
  getExactQueryCache,
  setExactQueryCache,
  getQueryCache,
  setQueryCache,
  incrementQueryCacheHits,
  logQuery,
  allergenFilterHash,
  embeddingToBucket,
} from "../cache/query-cache.js"
import { typesenseDocToDTO } from "../mappers/product-mapper.js"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { getTypesenseClient, COLLECTION } from "../typesense/client.js"

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

  const lunchStart = parseInt(process.env.RESTAURANT_LUNCH_START_HOUR || "11", 10)
  const lunchEnd = parseInt(process.env.RESTAURANT_LUNCH_END_HOUR || "15", 10)
  const dinnerStart = parseInt(process.env.RESTAURANT_DINNER_START_HOUR || "18", 10)
  const dinnerEnd = parseInt(process.env.RESTAURANT_DINNER_END_HOUR || "23", 10)

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
}

/**
 * Apply post-fetch filters that cannot be expressed as Typesense filter_by.
 * Availability window is time-dependent and product-specific.
 */
function applyFilters(products: ProductDTO[], filters: FilterOptions): ProductDTO[] {
  return products.filter((product) => {
    if (filters.tags && filters.tags.length > 0) {
      if (!filters.tags.some((tag) => product.tags.includes(tag))) return false
    }

    if (filters.availableNow && !isAvailableNow(product.availabilityWindow)) {
      return false
    }

    if (filters.excludeAllergens && filters.excludeAllergens.length > 0) {
      if (product.allergens.some((a) => filters.excludeAllergens!.includes(a))) return false
    }

    return true
  })
}

// ── Typesense search ──────────────────────────────────────────────────────────

interface TypesenseResult {
  hits: any[]
  totalFound: number
  scores: Record<string, number> // productId → relevance score
}

/**
 * Execute Typesense hybrid search (vector + keyword).
 * @param filterInStock — when false, omits `inStock:true` (diagnostic pass only)
 */
async function executeTypesenseSearch(
  query: string,
  embedding: number[],
  limit: number,
  filterInStock = true,
  productType?: "food" | "frozen" | "merchandise"
): Promise<TypesenseResult> {
  const typesenseClient = getTypesenseClient()

  const filterParts = ["status:published"]
  if (filterInStock) filterParts.push("inStock:true")
  if (productType) filterParts.push(`productType:${productType}`)
  
  const filterBy = filterParts.join(" && ")

  const response = await typesenseClient
    .collections(COLLECTION)
    .documents()
    .search({
      q: query,
      query_by: "title,description,tags",
      // Hybrid vector query — requires Typesense v0.25+ and embeddings stored in collection
      // Syntax: embedding:([dim0,dim1,...], k:N)
      vector_query: embedding.length > 0
        ? `embedding:([${embedding.join(",")}], k:${limit})`
        : undefined,
      filter_by: filterBy,
      facet_by: "tags,availabilityWindow,allergens",
      limit,
      per_page: limit,
    } as any)

  const hits = response.hits ?? []
  const scores: Record<string, number> = {}
  const docs: any[] = []

  for (const hit of hits) {
    const doc = hit.document as any
    docs.push(doc)
    if ((doc as any)?.id) {
      // Prefer rank_fusion_score (hybrid mode) over text_match_score (keyword mode)
      const score =
        ((hit as any).hybrid_search_info?.rank_fusion_score as number | undefined) ??
        ((hit as any).text_match_score as number | undefined) ??
        0
      scores[(doc as any).id] = score
    }
  }

  return {
    hits: docs,
    totalFound: (response as any).found ?? 0,
    scores,
  }
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
      const diagResult = await executeTypesenseSearch(query, embedding, limit, false, filters.productType)
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

/**
 * Run the full L0→embedding→L1→Typesense→filter→cache pipeline for a single query.
 * Does NOT publish NATS events (caller handles that after merging).
 */
async function singleQuerySearch(
  query: string,
  filters: FilterOptions,
  channel: Channel,
  userType: "guest" | "customer" | "staff",
  sessionId: string,
  limit: number,
  availabilityMode: "dynamic" | "all",
  allergenHash: string,
  cacheTtl: number
): Promise<SingleQueryResult> {
  // ── L0: Exact cache ──────────────────────────────────────────────────────
  const l0 = await getExactQueryCache(query, channel, availabilityMode, allergenHash, filters.productType)
  if (l0.hit) {
    return {
      query,
      products: l0.results,
      totalFound: l0.results.length,
      scores: {},
      hitCache: true,
      cachedAt: l0.cachedAt,
      searchModel: "hybrid",
    }
  }

  // ── Generate query embedding ─────────────────────────────────────────────
  let queryEmbedding: number[] = []
  try {
    queryEmbedding = await generateEmbedding(
      query,
      `embedding:query:${Buffer.from(query).toString("base64")}`
    )
  } catch (error) {
    console.warn("[Search] Query embedding failed; falling back to keyword search:", error)
  }

  // ── L1: Semantic bucket cache ────────────────────────────────────────────
  if (queryEmbedding.length > 0) {
    const l1 = await getQueryCache(channel, queryEmbedding, availabilityMode, allergenHash, filters.productType)
    if (l1.hit) {
      try {
        await incrementQueryCacheHits(channel, queryEmbedding, availabilityMode, allergenHash)
        await setExactQueryCache(query, channel, availabilityMode, allergenHash, l1.results, filters.productType)
      } catch (error) {
        console.warn("[Search] Cache backfill failed (non-critical):", error)
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
  }

  // ── L2: Typesense search ─────────────────────────────────────────────────
  let tsResult: TypesenseResult = { hits: [], totalFound: 0, scores: {} }
  try {
    tsResult = await executeTypesenseSearch(query, queryEmbedding, limit, true, filters.productType)
  } catch (error) {
    console.error("[Search] Typesense search failed:", error)
    // Graceful degradation — return empty
  }

  const rawDTOs = tsResult.hits.map((doc) => typesenseDocToDTO(doc))
  const products = applyFilters(rawDTOs, filters)

  // ── noResultsReason diagnostic (empty results only) ──────────────────────
  let noResultsReason: NoResultsReason | undefined
  if (products.length === 0) {
    try {
      noResultsReason = await diagnoseNoResults(query, queryEmbedding, limit, rawDTOs, filters)
    } catch (error) {
      console.warn("[Search] Diagnostic query failed (non-critical):", error)
    }
  }

  // ── Cache results ────────────────────────────────────────────────────────
  try {
    if (queryEmbedding.length > 0) {
      await setQueryCache(channel, queryEmbedding, products, availabilityMode, allergenHash, cacheTtl, filters.productType)
    }
    await setExactQueryCache(query, channel, availabilityMode, allergenHash, products, filters.productType)
  } catch (error) {
    console.warn("[Search] Cache write failed (non-critical):", error)
  }

  // ── Log query ────────────────────────────────────────────────────────────
  try {
    const bucket = queryEmbedding.length > 0 ? embeddingToBucket(queryEmbedding) : "no-embedding"
    await logQuery(sessionId, query, bucket, products.length, channel, userType)
  } catch (error) {
    console.warn("[Search] Query log failed (non-critical):", error)
  }

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
  userType?: "guest" | "customer" | "staff"
}

/**
 * Publish one product.viewed NATS event per product in results.
 * Non-blocking — caller swallows errors.
 */
async function publishViewedEvents(
  products: ProductDTO[],
  context?: SearchContext
): Promise<void> {
  const channel = context?.channel ?? Channel.Web
  const timestamp = new Date().toISOString()

  await Promise.all(
    products.map((product) => {
      const event: ProductViewedEvent = {
        eventType: "product.viewed",
        sessionId: context?.sessionId,
        customerId: context?.userId ?? null,
        channel,
        timestamp,
        metadata: {
          productId: product.id,
          source: "search",
        },
      }
      return publishNatsEvent("product.viewed", event)
    })
  )
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

  const dynamicTtl = parseInt(process.env.QUERY_CACHE_DYNAMIC_TTL_SECONDS || "600", 10)
  const staticTtl = parseInt(process.env.QUERY_CACHE_TTL_SECONDS || "3600", 10)
  const cacheTtl = availableNow ? dynamicTtl : staticTtl

  const filters: FilterOptions = {
    tags: validated.tags,
    availableNow,
    excludeAllergens: validated.excludeAllergens,
    productType: validated.productType,
  }

  // ── Determine query list ─────────────────────────────────────────────────
  // validated.query and validated.queries are each optional, but Zod refine ensures at least one
  const queryList: string[] = validated.queries?.length
    ? validated.queries
    : [validated.query as string]

  const isMultiQuery = queryList.length > 1

  // ── Run all queries in parallel ──────────────────────────────────────────
  const queryResults = await Promise.all(
    queryList.map((q) =>
      singleQuerySearch(q, filters, channel, userType, sessionId, limit, availabilityMode, allergenHash, cacheTtl)
    )
  )

  // ── Merge results ────────────────────────────────────────────────────────
  // Deduplicate by product ID — first occurrence (highest-relevance query) wins
  const seen = new Set<string>()
  const mergedProducts: ProductDTO[] = []
  const mergedScores: Record<string, number> = {}
  let anyLiveSearch = false
  let anyHybrid = false

  for (const result of queryResults) {
    if (!result.hitCache) anyLiveSearch = true
    if (result.searchModel === "hybrid") anyHybrid = true

    for (const product of result.products) {
      if (!seen.has(product.id)) {
        seen.add(product.id)
        mergedProducts.push(product)
        if (result.scores[product.id] !== undefined) {
          mergedScores[product.id] = result.scores[product.id]
        }
      }
    }
  }

  // Apply overall limit to merged products
  const products = mergedProducts.slice(0, limit)

  const totalFound = queryResults.reduce((sum, r) => sum + r.totalFound, 0)
  const hitCache = queryResults.every((r) => r.hitCache)
  const searchModel: "hybrid" | "keyword" = anyHybrid ? "hybrid" : "keyword"

  // ── noResultsReason (top-level, for single-query or fully-empty multi-query)
  let noResultsReason: SearchProductsOutput["noResultsReason"]
  if (products.length === 0) {
    if (!isMultiQuery) {
      noResultsReason = queryResults[0]?.noResultsReason
    } else {
      // All queries returned empty — pick the most informative reason
      const reasons = queryResults.map((r) => r.noResultsReason).filter(Boolean)
      // Priority: out_of_stock > allergen_filtered > not_available_now > no_match
      if (reasons.includes("out_of_stock")) noResultsReason = "out_of_stock"
      else if (reasons.includes("allergen_filtered")) noResultsReason = "allergen_filtered"
      else if (reasons.includes("not_available_now")) noResultsReason = "not_available_now"
      else noResultsReason = "no_match"
    }
  }

  // ── Publish product.viewed events ────────────────────────────────────────
  try {
    if (products.length > 0) {
      await publishViewedEvents(products, context)
    }
  } catch (error) {
    console.warn("[Search] Event publish failed (non-critical):", error)
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
        description: "Máximo de resultados (1–20, padrão 5)",
      },
    },
  },
}
