// Shared configuration for @ibatexas/tools

/** Embedding dimension — configurable via EMBEDDING_DIMENSION env var */
const parsed = Number.parseInt(process.env.EMBEDDING_DIMENSION || "1536", 10)
export const EMBED_DIM = isNaN(parsed) ? 1536 : parsed
