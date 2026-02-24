// @ibatexas/tools
// Agent tool definitions and utilities.
// Each tool is an isolated module — definition + handler.

// ── Search tool ────────────────────────────────────────────────────────────────
export { searchProducts, SearchProductsTool } from "./search/search-products.js"

// ── Catalog tools ──────────────────────────────────────────────────────────────
export { getProductDetails, GetProductDetailsTool } from "./catalog/get-product-details.js"

// ── Embeddings ─────────────────────────────────────────────────────────────────
export { generateEmbedding, generateEmbeddingsBatch } from "./embeddings/client.js"

// ── Redis ──────────────────────────────────────────────────────────────────────
export { getRedisClient, closeRedisClient } from "./redis/client.js"

// ── Vector utilities ───────────────────────────────────────────────────────────
export { cosineSimilarity } from "./utils/vectors.js"

// ── Mappers ────────────────────────────────────────────────────────────────────
export { medusaToTypesenseDoc, typesenseDocToDTO } from "./mappers/product-mapper.js"

// ── Query cache ────────────────────────────────────────────────────────────────
export {
  getQueryCache,
  setQueryCache,
  getExactQueryCache,
  setExactQueryCache,
  incrementQueryCacheHits,
  logQuery,
  embeddingToBucket,
  allergenFilterHash,
  invalidateAllQueryCache,
} from "./cache/query-cache.js"

// ── Embedding cache ────────────────────────────────────────────────────────────
export {
  getEmbeddingCache,
  setEmbeddingCache,
  deleteEmbeddingCache,
  batchSetEmbeddingCache,
  clearEmbeddingCache,
} from "./cache/embedding-cache.js"

// ── Typesense ──────────────────────────────────────────────────────────────────
export { getTypesenseClient, ensureCollectionExists, recreateCollection, PRODUCTS_COLLECTION_SCHEMA, COLLECTION } from "./typesense/client.js"
export { indexProduct, deleteProductFromIndex, indexProductsBatch } from "./typesense/index-product.js"

// ── Config ─────────────────────────────────────────────────────────────────────
export { EMBED_DIM } from "./config.js"

// ── Re-export shared types consumed by CLI and other packages ─────────────────
export { Channel } from "@ibatexas/types"
