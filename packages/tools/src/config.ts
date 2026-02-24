// Shared configuration for @ibatexas/tools

/** Embedding dimension — configurable via EMBEDDING_DIMENSION env var */
export const EMBED_DIM = parseInt(process.env.EMBEDDING_DIMENSION || "1536", 10)
