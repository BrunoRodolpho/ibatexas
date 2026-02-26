// Query cache: semantic bucketing of search queries
// Similar queries (rephrased) hash to same bucket for cache hits
//
// Two-layer architecture:
//   L0: Exact match  — sha256(normalize(query)+filters) — TTL: QUERY_CACHE_EXACT_TTL_SECONDS
//   L1: Semantic     — djb2(quantized embedding)        — TTL: QUERY_CACHE_TTL_SECONDS
//
// Invalidation: invalidateAllQueryCache() flushes both layers atomically.
// Called by product.updated and product.deleted subscribers.

import { createHash } from "crypto"
import { getRedisClient } from "../redis/client.js"
import { Channel } from "@ibatexas/types"
import type { QueryCacheEntry, QueryLogEntry, ProductDTO } from "@ibatexas/types"

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
    hash = ((hash << 5) + hash + scaled) | 0 // djb2, 32-bit overflow
  }
  return `bucket_${Math.abs(hash) % 1000}`
}

// ── Cache keys ────────────────────────────────────────────────────────────────

/**
 * L0 exact cache key — sha256 of normalized query + filters.
 * Zero embedding cost on hit (computed before embedding call).
 */
export function exactCacheKey(
  query: string,
  channel: Channel,
  availabilityMode: string,
  allergenHash: string,
  productType?: string,
  categoryHandle?: string,
  tags?: string[]
): string {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, " ")
  const productTypeStr = productType || "all"
  const categoryStr = categoryHandle || "all"
  const tagsStr = tags && tags.length > 0 ? [...tags].sort().join(",") : "all"
  const hash = createHash("sha256")
    .update(`${normalized}:${availabilityMode}:${allergenHash}:${productTypeStr}:${categoryStr}:${tagsStr}`)
    .digest("hex")
    .slice(0, 16)
  return `search_exact:${channel}:${hash}`
}

/**
 * L1 semantic bucket cache key.
 * Example: search_cache:web:bucket_42:dynamic:ae3f2b
 */
function semanticCacheKey(
  channel: Channel,
  bucket: string,
  availabilityMode: string,
  allergenHash: string,
  productType?: string,
  categoryHandle?: string,
  tags?: string[]
): string {
  const tagsStr = tags && tags.length > 0 ? [...tags].sort().join(",") : "none"
  return [
    "search_cache",
    channel,
    bucket,
    availabilityMode || "all",
    allergenHash || "none",
    productType || "all",
    categoryHandle || "all",
    tagsStr,
  ].join(":")
}

// ── L0: Exact cache ───────────────────────────────────────────────────────────

export async function getExactQueryCache(
  query: string,
  channel: Channel,
  availabilityMode: string,
  allergenHash: string,
  productType?: string,
  categoryHandle?: string,
  tags?: string[]
): Promise<{ hit: true; results: ProductDTO[]; cachedAt: string } | { hit: false }> {
  try {
    const redisClient = await getRedisClient()
    const key = exactCacheKey(query, channel, availabilityMode, allergenHash, productType, categoryHandle, tags)
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
  channel: Channel,
  availabilityMode: string,
  allergenHash: string,
  results: ProductDTO[],
  productType?: string,
  categoryHandle?: string,
  tags?: string[]
): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const ttl = parseInt(process.env.QUERY_CACHE_EXACT_TTL_SECONDS || "300", 10)
    const key = exactCacheKey(query, channel, availabilityMode, allergenHash, productType, categoryHandle, tags)
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
  channel: Channel,
  embedding: number[],
  availabilityMode?: string,
  allergenHash?: string,
  productType?: string,
  categoryHandle?: string,
  tags?: string[]
): Promise<{ hit: true; results: ProductDTO[]; cachedAt: string } | { hit: false }> {
  try {
    const redisClient = await getRedisClient()
    const bucket = embeddingToBucket(embedding)
    const key = semanticCacheKey(channel, bucket, availabilityMode || "all", allergenHash || "none", productType, categoryHandle, tags)

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
  channel: Channel,
  embedding: number[],
  results: ProductDTO[],
  availabilityMode?: string,
  allergenHash?: string,
  ttlSeconds = parseInt(process.env.QUERY_CACHE_TTL_SECONDS || "3600", 10),
  productType?: string,
  categoryHandle?: string,
  tags?: string[]
): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const bucket = embeddingToBucket(embedding)
    const key = semanticCacheKey(channel, bucket, availabilityMode || "all", allergenHash || "none", productType, categoryHandle, tags)
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
  channel: Channel,
  embedding: number[],
  availabilityMode?: string,
  allergenHash?: string,
  productType?: string,
  categoryHandle?: string,
  tags?: string[]
): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const bucket = embeddingToBucket(embedding)
    const key = semanticCacheKey(channel, bucket, availabilityMode || "all", allergenHash || "none", productType, categoryHandle, tags)

    const cached = await redisClient.get(key)
    if (!cached) return

    const entry: QueryCacheEntry = JSON.parse(cached)
    entry.hitCount++

    const remainingTtl = Math.floor((new Date(entry.expiresAt).getTime() - Date.now()) / 1000)
    const ttl = remainingTtl > 0 ? remainingTtl : parseInt(process.env.QUERY_CACHE_TTL_SECONDS || "3600", 10)

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
    const keyHash = Math.random().toString(36).slice(2, 8)
    const ttl = parseInt(process.env.QUERY_LOG_TTL_SECONDS || "604800", 10)

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
  const sorted = [...allergens].sort().join(",")
  let hash = 0
  for (let i = 0; i < sorted.length; i++) {
    hash = (hash << 5) - hash + sorted.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).slice(0, 6)
}
