// Embeddings client with caching
// Uses OpenAI with Redis cache and deterministic fallback

import { getRedisClient } from "../redis/client.js"
import { EMBED_DIM } from "../config.js"

// Use OpenAI embeddings (most reliable)
async function generateEmbeddingViaOpenAI(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return generateDeterministicEmbedding(text)
  }

  const model = process.env.EMBEDDING_MODEL || process.env.CLAUDE_EMBEDDING_MODEL || "text-embedding-3-small"
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text }),
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

// Fallback: deterministic embedding from text hash
// WARNING: semantically meaningless — only used when OpenAI is unavailable.
// Vector search will not work correctly with these embeddings.
function generateDeterministicEmbedding(text: string): number[] {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }

  const seed = Math.abs(hash)
  const embedding: number[] = []

  for (let i = 0; i < EMBED_DIM; i++) {
    const x = Math.sin(seed + i) * 10000
    embedding.push(x - Math.floor(x))
  }

  return embedding
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
    console.error("[embeddings] Failed to generate embedding:", error)
    embedding = generateDeterministicEmbedding(text)
  }

  if (!Array.isArray(embedding) || embedding.length !== EMBED_DIM) {
    throw new Error(`Invalid embedding: expected ${EMBED_DIM}-dim vector, got ${embedding?.length ?? "undefined"}`)
  }

  try {
    await redisClient.setEx(cacheKey, ttlSeconds, JSON.stringify(embedding))
  } catch (error) {
    console.warn("Failed to cache embedding:", error)
  }

  return embedding
}

/**
 * Batch embed multiple texts.
 * Returns array of embeddings; failed items logged.
 */
export async function generateEmbeddingsBatch(
  texts: Array<{ key: string; text: string }>,
  ttlSeconds = Number.parseInt(process.env.EMBEDDINGS_CACHE_TTL_SECONDS || "2592000", 10)
): Promise<{
  embeddings: Map<string, number[]>
  failures: Array<{ key: string; error: string }>
}> {
  const embeddings = new Map<string, number[]>()
  const failures: Array<{ key: string; error: string }> = []

  for (const { key, text } of texts) {
    try {
      const embedding = await generateEmbedding(text, `embedding:${key}`, ttlSeconds)
      embeddings.set(key, embedding)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      failures.push({ key, error: msg })
      console.warn(`Embedding failed for ${key}: ${msg}`)
    }
  }

  return { embeddings, failures }
}
