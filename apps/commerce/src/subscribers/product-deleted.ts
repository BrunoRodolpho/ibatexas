/**
 * Subscriber: product.deleted
 * Removes product from Typesense and invalidates query cache and embedding cache.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { deleteProductFromIndex, invalidateAllQueryCache, deleteEmbeddingCache } from "@ibatexas/tools"
import { publishNatsEvent } from "@ibatexas/nats-client"

export default async function productDeletedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    logger.info(`[Product Indexing] product.deleted: ${data.id}`)

    // Remove from search index (idempotent — ignores 404)
    await deleteProductFromIndex(data.id)

    // Invalidate all query caches — deleted product must not appear in results
    const flushed = await invalidateAllQueryCache()
    logger.info(`[Product Indexing] Flushed ${flushed} query cache entries`)

    // Delete cached embedding
    await deleteEmbeddingCache(data.id)

    await publishNatsEvent("product.indexed", {
      productId: data.id,
      action: "deleted",
      timestamp: new Date().toISOString(),
    })

    logger.info(`[Product Indexing] Deleted from index: ${data.id}`)
  } catch (error) {
    logger.error(`[Product Indexing] product.deleted handler failed for ${data.id}:`, error instanceof Error ? error : new Error(String(error)))
  }
}

export const config: SubscriberConfig = {
  event: "product.deleted",
}
