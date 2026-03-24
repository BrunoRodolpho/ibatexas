/**
 * Subscriber: product.updated
 * Re-indexes product to Typesense and invalidates query cache.
 * Cache flush ensures admin changes (price, stock, availability) are immediately reflected.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { invalidateAllQueryCache } from "@ibatexas/tools"
import { fetchAndIndexProduct } from "./_product-indexing"

export default async function productUpdatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    logger.info(`[Product Indexing] product.updated: ${data.id}`)

    const product = await fetchAndIndexProduct(data.id, container, "updated")
    if (!product) {
      logger.warn(`[Product Indexing] product.updated: ${data.id} not found`)
      return
    }

    // Invalidate all query caches — product data changed (price, stock, availability)
    const flushed = await invalidateAllQueryCache()
    logger.info(`[Product Indexing] Flushed ${flushed} query cache entries`)

    logger.info(`[Product Indexing] Re-indexed: ${product.id} (${product.title})`)
  } catch (error) {
    logger.error(`[Product Indexing] product.updated handler failed for ${data.id}:`, error instanceof Error ? error : new Error(String(error)))
  }
}

export const config: SubscriberConfig = {
  event: "product.updated",
}
