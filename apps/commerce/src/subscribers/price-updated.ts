/**
 * Subscriber: pricing.price.updated / pricing.price.created / pricing.price.deleted
 *
 * In Medusa v2, editing a variant's price in the admin UI fires pricing module
 * events — NOT product-variant.updated. This subscriber catches those events,
 * resolves the parent product via price_set → variant link, and re-indexes to
 * Typesense so the storefront immediately reflects the new price.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { indexProduct, invalidateAllQueryCache, deleteEmbeddingCache } from "@ibatexas/tools"
import { publishNatsEvent } from "@ibatexas/nats-client"

export default async function priceUpdatedHandler({
  event: { data, name: eventName },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    const priceId = data.id
    logger.info(`[Product Indexing] ${eventName}: ${priceId}`)

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Resolve: price → price_set → variant link → variant → product
    // Step 1: Get price_set_id from the price record
    const { data: prices } = await query.graph({
      entity: "price",
      fields: ["id", "price_set_id"],
      filters: { id: priceId },
    })
    const price = prices[0] as { id: string; price_set_id: string } | undefined
    if (!price?.price_set_id) {
      logger.warn(`[Product Indexing] price ${priceId} — price_set not found`)
      return
    }

    // Step 2: Find the variant linked to this price_set
    const { data: links } = await query.graph({
      entity: "product_variant_price_set",
      fields: ["variant_id", "price_set_id"],
      filters: { price_set_id: price.price_set_id },
    })
    const link = links[0] as { variant_id: string; price_set_id: string } | undefined
    if (!link?.variant_id) {
      // Price set may not be linked to a product variant (e.g. shipping prices)
      logger.info(`[Product Indexing] price_set ${price.price_set_id} has no variant link — skipping`)
      return
    }

    // Step 3: Get the parent product ID from the variant
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "product_id"],
      filters: { id: link.variant_id },
    })
    const variant = variants[0] as { id: string; product_id: string } | undefined
    if (!variant?.product_id) {
      logger.warn(`[Product Indexing] variant ${link.variant_id} — parent product not found`)
      return
    }

    const productId = variant.product_id

    // Step 4: Fetch full product with all relations for re-indexing
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
      filters: { id: productId },
    })
    const product = products[0]
    if (!product) {
      logger.warn(`[Product Indexing] product ${productId} not found for price ${priceId}`)
      return
    }

    // Re-index to Typesense (upsert is idempotent)
    await indexProduct(product)

    // Invalidate all query caches — price data changed
    const flushed = await invalidateAllQueryCache()
    logger.info(`[Product Indexing] Flushed ${flushed} query cache entries`)

    // Force re-embedding on next query (clear stale cached embedding)
    await deleteEmbeddingCache(product.id)

    await publishNatsEvent("product.indexed", {
      productId: product.id,
      action: "price-updated",
      priceId,
      variantId: link.variant_id,
      title: product.title,
      timestamp: new Date().toISOString(),
    })

    logger.info(`[Product Indexing] Re-indexed after price change: ${product.id} (${product.title})`)
  } catch (error) {
    logger.error(
      `[Product Indexing] price-updated handler failed for ${data.id}:`,
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

export const config: SubscriberConfig = {
  event: [
    "pricing.price.updated",
    "pricing.price.created",
    "pricing.price.deleted",
  ],
}
