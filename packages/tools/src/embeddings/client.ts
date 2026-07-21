// Embeddings client with caching.
// Two selectable providers (BKL-034), both behind a Redis cache; FAILS HONEST
// when the selected provider is not configured (→ keyword-only degrade):
//   - openai (default): OpenAI /v1/embeddings (text-embedding-3-small, 1536-dim).
//   - ollama: a LOCAL Ollama /api/embeddings model (e.g. nomic-embed-text,
//     768-dim) — zero external keys. Select with EMBEDDINGS_PROVIDER=ollama.

import { getRedisClient } from "../redis/client.js"
import { EMBED_DIM } from "../config.js"

/**
 * Thrown when embeddings cannot be produced — the SELECTED provider is not
 * configured (openai + no OPENAI_API_KEY, or ollama + no OLLAMA_EMBED_URL/
 * MODEL). FE-D17: the client NEVER substitutes a semantically-meaningless
 * pseudo-vector — a fabricated embedding made vector search "match" unrelated
 * products ('coca' and 'xyzzy' both hitting the same arbitrary item). Callers
 * catch this and degrade to keyword-only search / index-without-embedding.
 */
export class EmbeddingsUnavailableError extends Error {
  constructor(message = "No embeddings provider is configured — embeddings unavailable") {
    super(message)
    this.name = "EmbeddingsUnavailableError"
  }
}

/** The configured embeddings provider (BKL-034). Read at CALL time (never
 *  captured at import — FE-D26 lazy-env discipline). Default openai for
 *  back-compat; any other value than "ollama" falls back to openai. */
type EmbeddingProvider = "openai" | "ollama"
function resolveEmbeddingProvider(): EmbeddingProvider {
  return (process.env.EMBEDDINGS_PROVIDER ?? "openai").trim().toLowerCase() === "ollama"
    ? "ollama"
    : "openai"
}

/**
 * Cache-key namespace version, DERIVED from the provider so vectors from
 * DIFFERENT embedding spaces never collide in Redis (the FE-D17 poison class:
 * a query vector from one space matched against stored vectors from another is
 * meaningless). openai → v2, ollama → v3. Read at call time; callers build
 * their cache keys with this suffix (search-products.ts / index-product.ts).
 */
export function embeddingCacheVersion(): string {
  return resolveEmbeddingProvider() === "ollama" ? "v3" : "v2"
}

/** Once-per-process latch for the expected provider-unconfigured warning. */
let providerUnavailableWarnedOnce = false

// Use OpenAI embeddings (the default provider).
async function generateEmbeddingViaOpenAI(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new EmbeddingsUnavailableError("OPENAI_API_KEY is not set — embeddings unavailable")
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

// Use a LOCAL Ollama embedding model (BKL-034) — zero external keys. Ollama's
// native embeddings endpoint is POST /api/embeddings { model, prompt } →
// { embedding: number[] } (single input; the OpenAI-compat /v1/embeddings also
// exists but the native route is the sanctioned one here).
async function generateEmbeddingViaOllama(text: string): Promise<number[]> {
  const baseUrl = process.env.OLLAMA_EMBED_URL
  const model = process.env.OLLAMA_EMBED_MODEL
  if (!baseUrl || !model) {
    throw new EmbeddingsUnavailableError(
      "EMBEDDINGS_PROVIDER=ollama but OLLAMA_EMBED_URL / OLLAMA_EMBED_MODEL is not set — embeddings unavailable",
    )
  }

  // 10s timeout prevents indefinite hangs if the local model box is offline.
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error("[embeddings] Ollama API error:", { status: response.status, error: errorText })
    throw new Error(`Ollama embedding API failed: ${response.statusText}`)
  }

  const raw: unknown = await response.json()
  const data = raw as { embedding?: number[] }

  if (!data.embedding || !Array.isArray(data.embedding) || data.embedding.length === 0) {
    throw new Error("No embedding in Ollama response")
  }

  return data.embedding
}

/** Dispatch to the configured provider. The OpenAI branch is byte-behaviorally
 *  identical to pre-BKL-034 when EMBEDDINGS_PROVIDER is unset/openai. */
async function generateEmbeddingViaProvider(text: string): Promise<number[]> {
  return resolveEmbeddingProvider() === "ollama"
    ? generateEmbeddingViaOllama(text)
    : generateEmbeddingViaOpenAI(text)
}

/**
 * STARTUP sanity check (BKL-034): when a provider IS configured, embed a probe
 * and assert its dimension matches EMBED_DIM (EMBEDDING_DIMENSION). A mismatch
 * — e.g. EMBEDDINGS_PROVIDER=ollama with nomic-embed-text (768) while
 * EMBEDDING_DIMENSION is still 1536 — would silently POISON Typesense (whose
 * collection `num_dim` is baked from EMBED_DIM), so fail LOUD at boot instead.
 * No-ops when no provider is configured (keyword-only degrade is the honest
 * state — the per-call guard in generateEmbedding still protects every write).
 * Exported for a consuming app to call once at bootstrap.
 */
export async function assertEmbeddingProviderDimension(): Promise<void> {
  let probe: number[]
  try {
    probe = await generateEmbeddingViaProvider("dimensão")
  } catch (error) {
    // No provider configured → nothing to verify (keyword-only degrade).
    if (error instanceof EmbeddingsUnavailableError) return
    throw error
  }
  if (probe.length !== EMBED_DIM) {
    throw new Error(
      `Embedding dimension mismatch: provider '${resolveEmbeddingProvider()}' returned ` +
        `${probe.length}-dim but EMBEDDING_DIMENSION=${EMBED_DIM}. Set EMBEDDING_DIMENSION to ` +
        `match the model (nomic-embed-text=768, text-embedding-3-small=1536) and reindex Typesense.`,
    )
  }
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
    embedding = await generateEmbeddingViaProvider(text)
  } catch (error) {
    // FE-D17: fail honest — RETHROW rather than substitute a pseudo-vector.
    // Callers degrade correctly: search-products.ts catches → keyword-only
    // search; index-product.ts catches → indexes the doc without an embedding.
    // An unconfigured provider is the EXPECTED state on a bare local stack and
    // hits every non-wildcard search — warn once per process, not per call.
    if (error instanceof EmbeddingsUnavailableError) {
      if (!providerUnavailableWarnedOnce) {
        providerUnavailableWarnedOnce = true
        console.warn(`[embeddings] ${error.message} — keyword-only search for this process (logged once)`)
      }
    } else {
      console.error("[embeddings] Failed to generate embedding:", (error as Error).message)
    }
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
