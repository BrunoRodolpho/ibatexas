/**
 * Subscriber: product.deleted
 * Removes product from Typesense and invalidates query cache and embedding cache.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { deleteProductFromIndex, invalidateAllQueryCache, deleteEmbeddingCache } from "@ibatexas/tools"
import { withTypesenseRetry } from "./_product-indexing"

export default async function productDeletedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    logger.info(`[Product Indexing] product.deleted: ${data.id}`)

    // Remove from search index with retry (idempotent — ignores 404)
    await withTypesenseRetry(
      () => deleteProductFromIndex(data.id),
      `deleteProductFromIndex(${data.id})`,
      logger,
    )

    // Invalidate all query caches — deleted product must not appear in results
    const flushed = await invalidateAllQueryCache()
    logger.info(`[Product Indexing] Flushed ${flushed} query cache entries`)

    // Delete cached embedding
    await deleteEmbeddingCache(data.id)

    logger.info(`[Product Indexing] Deleted from index: ${data.id}`)
  } catch (error) {
    logger.error(`[Product Indexing] product.deleted handler failed for ${data.id}:`, error instanceof Error ? error : new Error(String(error)))
  }
}

export const config: SubscriberConfig = {
  event: "product.deleted",
}
