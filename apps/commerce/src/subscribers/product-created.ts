/**
 * Subscriber: product.created
 * Indexes new product to Typesense. Does NOT invalidate query cache —
 * new products don't stale existing cached results.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { indexProduct } from "@ibatexas/tools"
import { publishNatsEvent } from "@ibatexas/nats-client"

export default async function productCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    logger.info(`[Product Indexing] product.created: ${data.id}`)

    const productService = container.resolve(Modules.PRODUCT)
    const product = await productService.retrieveProduct(data.id, {
      relations: ["variants", "variants.prices"],
    })

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
