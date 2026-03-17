/**
 * Subscriber: product.created
 * Indexes new product to Typesense. Does NOT invalidate query cache —
 * new products don't stale existing cached results.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { fetchAndIndexProduct } from "./_product-indexing"

export default async function productCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    logger.info(`[Product Indexing] product.created: ${data.id}`)

    const product = await fetchAndIndexProduct(data.id, container, "created")
    if (!product) {
      logger.warn(`[Product Indexing] product.created: ${data.id} not found`)
      return
    }

    logger.info(`[Product Indexing] Indexed: ${product.id} (${product.title})`)
  } catch (error) {
    // Non-blocking: indexing failure must not prevent product creation
    logger.error(`[Product Indexing] product.created handler failed for ${data.id}:`, error instanceof Error ? error : new Error(String(error)))
  }
}

export const config: SubscriberConfig = {
  event: "product.created",
}
