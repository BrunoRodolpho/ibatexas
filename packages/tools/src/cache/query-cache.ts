// Query cache: semantic bucketing of search queries
// Similar queries (rephrased) hash to same bucket for cache hits
//
// Two-layer architecture:
//   L0: Exact match  — sha256(normalize(query)+filters) — TTL: QUERY_CACHE_EXACT_TTL_SECONDS
//   L1: Semantic     — djb2(quantized embedding)        — TTL: QUERY_CACHE_TTL_SECONDS
//
// Invalidation: invalidateAllQueryCache() flushes both layers atomically.
// Called by product.updated and product.deleted subscribers.

import { createHash } from "node:crypto"
import { getRedisClient } from "../redis/client.js"
import { Channel, type QueryCacheEntry, type QueryLogEntry, type ProductDTO } from "@ibatexas/types"

// ── Shared filter context ─────────────────────────────────────────────────────

/** Common filter parameters shared by all cache key and cache access functions. */
export interface CacheFilterContext {
  channel: Channel
  availabilityMode: string
  allergenHash: string
  productType?: string
  categoryHandle?: string
  tags?: string[]
}

// ── Bucket ────────────────────────────────────────────────────────────────────

/**
 * Map an embedding to a semantic bucket string.
 *
 * Algorithm:
 * 1. Quantize each dimension to 1 decimal place (groups embeddings differing only by FP noise)
 * 2. djb2 hash that preserves sign (direction matters for cosine similarity)
 * 3. Map to 0–999 integer bucket (0.1% collision probability vs 1% for 100 buckets)
 *
 * Result: semantically similar rephrased queries land in the same bucket.
 * Different queries with the same L1 norm no longer collide (sign is preserved).
 */
export function embeddingToBucket(embedding: number[]): string {
  let hash = 5381
  for (const v of embedding) {
    const scaled = Math.round(v * 10) // quantize to 1 decimal; preserves sign
    hash = Math.trunc((hash << 5) + hash + scaled) // djb2, 32-bit overflow
  }
  return `bucket_${Math.abs(hash) % 1000}`
}

// ── Cache keys ────────────────────────────────────────────────────────────────

/**
 * L0 exact cache key — sha256 of normalized query + filters.
 * Zero embedding cost on hit (computed before embedding call).
 */
export function exactCacheKey(query: string, ctx: CacheFilterContext): string {
  const normalized = query.toLowerCase().trim().replaceAll(/\s+/g, " ")
  const productTypeStr = ctx.productType || "all"
  const categoryStr = ctx.categoryHandle || "all"
  const tagsStr = ctx.tags && ctx.tags.length > 0 ? [...ctx.tags].sort((a, b) => a.localeCompare(b)).join(",") : "all"
  const hash = createHash("sha256")
    .update(`${normalized}:${ctx.availabilityMode}:${ctx.allergenHash}:${productTypeStr}:${categoryStr}:${tagsStr}`)
    .digest("hex")
    .slice(0, 16)
  return `search_exact:${ctx.channel}:${hash}`
}

/**
 * L1 semantic bucket cache key.
 * Example: search_cache:web:bucket_42:dynamic:ae3f2b
 */
function semanticCacheKey(bucket: string, ctx: CacheFilterContext): string {
  const tagsStr = ctx.tags && ctx.tags.length > 0 ? [...ctx.tags].sort((a, b) => a.localeCompare(b)).join(",") : "none"
  return [
    "search_cache",
    ctx.channel,
    bucket,
    ctx.availabilityMode || "all",
    ctx.allergenHash || "none",
    ctx.productType || "all",
    ctx.categoryHandle || "all",
    tagsStr,
  ].join(":")
}

// ── L0: Exact cache ───────────────────────────────────────────────────────────

export async function getExactQueryCache(
  query: string,
  ctx: CacheFilterContext,
): Promise<{ hit: true; results: ProductDTO[]; cachedAt: string } | { hit: false }> {
  try {
    const redisClient = await getRedisClient()
    const key = exactCacheKey(query, ctx)
    const cached = await redisClient.get(key)
    if (cached) {
      const parsed = JSON.parse(cached) as { results: ProductDTO[]; cachedAt: string }
      return { hit: true, results: parsed.results, cachedAt: parsed.cachedAt }
    }
    return { hit: false }
  } catch (error) {
    console.warn("[Cache] L0 exact cache read failed:", error)
    return { hit: false }
  }
}

export async function setExactQueryCache(
  query: string,
  ctx: CacheFilterContext,
  results: ProductDTO[],
): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const ttl = Number.parseInt(process.env.QUERY_CACHE_EXACT_TTL_SECONDS || "300", 10)
    const key = exactCacheKey(query, ctx)
    const payload = { results, cachedAt: new Date().toISOString() }
    await redisClient.setEx(key, ttl, JSON.stringify(payload))
  } catch (error) {
    console.warn("[Cache] L0 exact cache write failed:", error)
  }
}

// ── L1: Semantic bucket cache ─────────────────────────────────────────────────

/**
 * Get cached search results if available.
 */
export async function getQueryCache(
  embedding: number[],
  ctx: CacheFilterContext,
): Promise<{ hit: true; results: ProductDTO[]; cachedAt: string } | { hit: false }> {
  try {
    const redisClient = await getRedisClient()
    const bucket = embeddingToBucket(embedding)
    const key = semanticCacheKey(bucket, ctx)

    const cached = await redisClient.get(key)
    if (cached) {
      const entry: QueryCacheEntry = JSON.parse(cached)
      return { hit: true, results: entry.results, cachedAt: entry.cachedAt }
    }

    return { hit: false }
  } catch (error) {
    console.warn("[Cache] L1 semantic cache read failed:", error)
    return { hit: false }
  }
}

/**
 * Store search results in L1 semantic cache.
 */
export async function setQueryCache(
  embedding: number[],
  results: ProductDTO[],
  ctx: CacheFilterContext,
  ttlSeconds = Number.parseInt(process.env.QUERY_CACHE_TTL_SECONDS || "3600", 10),
): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const bucket = embeddingToBucket(embedding)
    const key = semanticCacheKey(bucket, ctx)
    const now = new Date()

    const entry: QueryCacheEntry = {
      embedding,
      bucket,
      results,
      resultCount: results.length,
      hitCount: 0,
      cachedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    }

    await redisClient.setEx(key, ttlSeconds, JSON.stringify(entry))
  } catch (error) {
    console.warn("[Cache] L1 semantic cache write failed:", error)
  }
}

/**
 * Increment hit counter and write back to Redis.
 * Uses remaining TTL from expiresAt to avoid resetting TTL to wrong value.
 */
export async function incrementQueryCacheHits(
  embedding: number[],
  ctx: CacheFilterContext,
): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const bucket = embeddingToBucket(embedding)
    const key = semanticCacheKey(bucket, ctx)

    const cached = await redisClient.get(key)
    if (!cached) return

    const entry: QueryCacheEntry = JSON.parse(cached)
    entry.hitCount++

    const remainingTtl = Math.floor((new Date(entry.expiresAt).getTime() - Date.now()) / 1000)
    const ttl = remainingTtl > 0 ? remainingTtl : Number.parseInt(process.env.QUERY_CACHE_TTL_SECONDS || "3600", 10)

    await redisClient.setEx(key, ttl, JSON.stringify(entry))
  } catch (error) {
    console.warn("[Cache] Hit increment failed:", error)
  }
}

// ── Cache invalidation ────────────────────────────────────────────────────────

/**
 * Invalidate all query cache entries (L0 + L1).
 * Called on product.updated and product.deleted to ensure stale results
 * (wrong price, wrong stock, deleted items) are never served.
 *
 * Strategy: full flush (Option B). Appropriate for <200 products, <10k queries/day.
 * For higher scale, replace with reverse index (Shopify-style surrogate keys).
 */
export async function invalidateAllQueryCache(): Promise<number> {
  try {
    const redisClient = await getRedisClient()
    const keys: string[] = []

    for await (const key of redisClient.scanIterator({ MATCH: "search_cache:*", COUNT: 100 })) {
      keys.push(key)
    }
    for await (const key of redisClient.scanIterator({ MATCH: "search_exact:*", COUNT: 100 })) {
      keys.push(key)
    }

    if (keys.length > 0) {
      await redisClient.del(keys)
      console.log(`[Cache] Invalidated ${keys.length} query cache entries`)
    }

    return keys.length
  } catch (error) {
    console.warn("[Cache] Query cache invalidation failed:", error)
    return 0
  }
}

// ── Query logging ─────────────────────────────────────────────────────────────

/**
 * Log user query for analysis.
 * Stores bucket string (not full embedding) to keep Redis storage small.
 * TTL: QUERY_LOG_TTL_SECONDS (default 7 days).
 */
export async function logQuery(
  sessionId: string,
  queryText: string,
  bucket: string,
  resultsCount: number,
  channel: Channel,
  userType: "guest" | "customer" | "staff"
): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const timestamp = new Date().toISOString()
    const keyHash = crypto.randomUUID().slice(0, 8)
    const ttl = Number.parseInt(process.env.QUERY_LOG_TTL_SECONDS || "604800", 10)

    const entry: QueryLogEntry = {
      sessionId,
      timestamp,
      queryText,
      bucket,
      resultsCount,
      channel,
      userType,
    }

    await redisClient.setEx(`query_log:${timestamp}:${sessionId}:${keyHash}`, ttl, JSON.stringify(entry))
  } catch (error) {
    console.warn("[Cache] Query logging failed:", error)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute a stable hash of allergen filter list for cache key.
 * Order-independent: ["lactose","nuts"] == ["nuts","lactose"].
 */
export function allergenFilterHash(allergens?: string[]): string {
  if (!allergens || allergens.length === 0) {
    return ""
  }
  const sorted = [...allergens].sort((a, b) => a.localeCompare(b)).join(",")
  let hash = 0
  for (let i = 0; i < sorted.length; i++) {
    hash = (hash << 5) - hash + (sorted.codePointAt(i) ?? 0)
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).slice(0, 6)
}
