// Embeddings client with caching
// Uses OpenAI with a Redis cache; FAILS HONEST when no key is configured.

import { getRedisClient } from "../redis/client.js"
import { EMBED_DIM } from "../config.js"

/**
 * Thrown when embeddings cannot be produced (no OPENAI_API_KEY, or an OpenAI
 * error). FE-D17: the client NEVER substitutes a semantically-meaningless
 * pseudo-vector — a fabricated embedding made vector search "match" unrelated
 * products ('coca' and 'xyzzy' both hitting the same arbitrary item). Callers
 * catch this and degrade to keyword-only search / index-without-embedding.
 */
export class EmbeddingsUnavailableError extends Error {
  constructor(message = "OPENAI_API_KEY is not set — embeddings unavailable") {
    super(message)
    this.name = "EmbeddingsUnavailableError"
  }
}

// Use OpenAI embeddings (most reliable)
async function generateEmbeddingViaOpenAI(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new EmbeddingsUnavailableError()
  }

  const model = process.env.EMBEDDING_MODEL || process.env.CLAUDE_EMBEDDING_MODEL || "text-embedding-3-small"
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"

  // 10s timeout prevents indefinite hangs during OpenAI API outages
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error("[embeddings] OpenAI API error:", { status: response.status, error: errorText })
    throw new Error(`Embedding API failed: ${response.statusText}`)
  }

  const raw: unknown = await response.json()
  const data = raw as { data?: Array<{ embedding: number[] }> }

  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error("No embeddings in OpenAI response")
  }

  return data.data[0].embedding
}

/**
 * Generate embedding for text, caching in Redis.
 *
 * @param text — Product description or query
 * @param cacheKey — Redis key (e.g., "embedding:prod_123")
 * @param ttlSeconds — Cache TTL; default 30 days
 * @returns 1536-dimensional vector
 */
export async function generateEmbedding(
  text: string,
  cacheKey: string,
  ttlSeconds = Number.parseInt(process.env.EMBEDDINGS_CACHE_TTL_SECONDS || "2592000", 10)
): Promise<number[]> {
  if (!text || text.length === 0) {
    throw new Error("Cannot embed empty text")
  }

  const redisClient = await getRedisClient()

  const cached = await redisClient.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  let embedding: number[]
  try {
    embedding = await generateEmbeddingViaOpenAI(text)
  } catch (error) {
    // FE-D17: fail honest — RETHROW rather than substitute a pseudo-vector.
    // Callers degrade correctly: search-products.ts catches → keyword-only
    // search; index-product.ts catches → indexes the doc without an embedding.
    console.error("[embeddings] Failed to generate embedding:", (error as Error).message)
    throw error
  }

  if (!Array.isArray(embedding) || embedding.length !== EMBED_DIM) {
    throw new Error(`Invalid embedding: expected ${EMBED_DIM}-dim vector, got ${embedding?.length ?? "undefined"}`)
  }

  try {
    await redisClient.setEx(cacheKey, ttlSeconds, JSON.stringify(embedding))
  } catch (error) {
    console.warn("Failed to cache embedding:", (error as Error).message)
  }

  return embedding
}
