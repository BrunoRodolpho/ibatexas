/**
 * Subscriber: product.updated
 * Re-indexes product to Typesense and invalidates query cache.
 * Cache flush ensures admin changes (price, stock, availability) are immediately reflected.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { indexProduct, invalidateAllQueryCache, deleteEmbeddingCache } from "@ibatexas/tools"
import { publishNatsEvent } from "@ibatexas/nats-client"

export default async function productUpdatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    logger.info(`[Product Indexing] product.updated: ${data.id}`)

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: products } = await query.graph({
      entity: "product",
      fields: [
        "*",
        "variants.*",
        "variants.prices.*",
        "tags.*",
        "categories.*",
        "images.*",
      ],
      filters: { id: data.id },
    })
    const product = products[0]
    if (!product) {
      logger.warn(`[Product Indexing] product.updated: ${data.id} not found`)
      return
    }

    // Re-index to Typesense (upsert is idempotent)
    await indexProduct(product)

    // Invalidate all query caches — product data changed (price, stock, availability)
    const flushed = await invalidateAllQueryCache()
    logger.info(`[Product Indexing] Flushed ${flushed} query cache entries`)

    // Force re-embedding on next index (clear stale cached embedding)
    await deleteEmbeddingCache(product.id)

    await publishNatsEvent("product.indexed", {
      productId: product.id,
      action: "updated",
      title: product.title,
      timestamp: new Date().toISOString(),
    })

    logger.info(`[Product Indexing] Re-indexed: ${product.id} (${product.title})`)
  } catch (error) {
    logger.error(`[Product Indexing] product.updated handler failed for ${data.id}:`, error instanceof Error ? error : new Error(String(error)))
  }
}

export const config: SubscriberConfig = {
  event: "product.updated",
}
