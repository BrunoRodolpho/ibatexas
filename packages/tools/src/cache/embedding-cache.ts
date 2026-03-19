// Product embedding cache
// Caches generated embeddings to avoid re-computing on product updates

import { getRedisClient } from "../redis/client.js"
import { rk } from "../redis/key.js"
import type { ProductEmbedding } from "@ibatexas/types"

/**
 * Get cached product embedding.
 */
export async function getEmbeddingCache(productId: string): Promise<number[] | null> {
  try {
    const redisClient = await getRedisClient()
    const key = rk(`product_embedding:${productId}`)
    const cached = await redisClient.get(key)
    // AUDIT-FIX: REDIS-C01 — add 30-day TTL to cache:stats counters (unbounded growth)
    const CACHE_STATS_TTL = 30 * 86400 // 30 days
    if (cached) {
      redisClient.incr(rk("cache:stats:embed:hit")).then(() => redisClient.expire(rk("cache:stats:embed:hit"), CACHE_STATS_TTL)).catch(() => {})
      return JSON.parse(cached) as number[]
    }
    redisClient.incr(rk("cache:stats:embed:miss")).then(() => redisClient.expire(rk("cache:stats:embed:miss"), CACHE_STATS_TTL)).catch(() => {})
    return null
  } catch (error) {
    console.warn(`Embedding cache read failed for ${productId}:`, (error as Error).message)
    return null
  }
}

/**
 * Store product embedding in cache.
 * TTL: 30 days (configurable via EMBEDDINGS_CACHE_TTL_SECONDS).
 */
export async function setEmbeddingCache(
  embedding: ProductEmbedding,
  ttlSeconds?: number
): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const ttl = ttlSeconds || Number.parseInt(process.env.EMBEDDINGS_CACHE_TTL_SECONDS || "2592000", 10)
    const key = rk(`product_embedding:${embedding.productId}`)
    await redisClient.setEx(key, ttl, JSON.stringify(embedding.embedding))
  } catch (error) {
    console.warn(`Embedding cache write failed for ${embedding.productId}:`, (error as Error).message)
  }
}

/**
 * Delete cached embedding (call on product delete).
 */
export async function deleteEmbeddingCache(productId: string): Promise<void> {
  try {
    const redisClient = await getRedisClient()
    const key = rk(`product_embedding:${productId}`)
    await redisClient.del(key)
  } catch (error) {
    console.warn(`Embedding cache delete failed for ${productId}:`, (error as Error).message)
  }
}

/**
 * Batch store embeddings using a Redis pipeline (single round-trip).
 */
export async function batchSetEmbeddingCache(
  embeddings: ProductEmbedding[],
  ttlSeconds?: number
): Promise<{ success: number; failed: number }> {
  const ttl = ttlSeconds || Number.parseInt(process.env.EMBEDDINGS_CACHE_TTL_SECONDS || "2592000", 10)
  let success = 0
  let failed = 0

  try {
    const redisClient = await getRedisClient()
    const pipeline = redisClient.multi()
    for (const embedding of embeddings) {
      pipeline.setEx(rk(`product_embedding:${embedding.productId}`), ttl, JSON.stringify(embedding.embedding))
    }
    await pipeline.exec()
    success = embeddings.length
  } catch (error) {
    console.warn("Batch embedding cache write failed:", (error as Error).message)
    failed = embeddings.length
  }

  return { success, failed }
}

/**
 * Clear entire embedding cache using SCAN (non-blocking).
 * Use for forced reindex. Returns number of keys deleted.
 */
export async function clearEmbeddingCache(): Promise<number> {
  try {
    const redisClient = await getRedisClient()
    const keys: string[] = []

    for await (const key of redisClient.scanIterator({ MATCH: rk("product_embedding:*"), COUNT: 100 })) {
      keys.push(key)
    }

    if (keys.length > 0) {
      await redisClient.del(keys)
    }

    return keys.length
  } catch (error) {
    console.warn("Embedding cache clear failed:", (error as Error).message)
    return 0
  }
}
