/**
 * Subscriber: product.created
 * Indexes new product to Typesense. Does NOT invalidate query cache —
 * new products don't stale existing cached results.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { indexProduct } from "@ibatexas/tools"
import { publishNatsEvent } from "@ibatexas/nats-client"

export default async function productCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    logger.info(`[Product Indexing] product.created: ${data.id}`)

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: products } = await query.graph({
      entity: "product",
      fields: [
        "*",
        "variants.*",
        "variants.price_set.*",
        "variants.price_set.prices.*",
        "tags.*",
        "categories.*",
        "images.*",
      ],
      filters: { id: data.id },
    })
    const product = products[0]
    if (!product) {
      logger.warn(`[Product Indexing] product.created: ${data.id} not found`)
      return
    }

    await indexProduct(product)

    await publishNatsEvent("product.indexed", {
      productId: product.id,
      action: "created",
      title: product.title,
      timestamp: new Date().toISOString(),
    })

    logger.info(`[Product Indexing] Indexed: ${product.id} (${product.title})`)
  } catch (error) {
    // Non-blocking: indexing failure must not prevent product creation
    logger.error(`[Product Indexing] product.created handler failed for ${data.id}:`, error instanceof Error ? error : new Error(String(error)))
  }
}

export const config: SubscriberConfig = {
  event: "product.created",
}
