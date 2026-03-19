/**
 * Subscriber: product-variant.updated
 * Triggered when a product variant is updated (including price changes via admin).
 * Looks up the parent product and re-indexes it to Typesense so price changes
 * are immediately reflected in the storefront UI.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { indexProduct, invalidateAllQueryCache, deleteEmbeddingCache } from "@ibatexas/tools"
import { withTypesenseRetry } from "./_product-indexing"

export default async function variantUpdatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    const variantId = data.id
    logger.info(`[Product Indexing] product-variant.updated: ${variantId}`)

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Find the parent product for this variant
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "product_id"],
      filters: { id: variantId },
    })
    const variant = variants[0] as { id: string; product_id: string } | undefined
    if (!variant?.product_id) {
      logger.warn(`[Product Indexing] variant ${variantId} — parent product not found`)
      return
    }

    const productId = variant.product_id

    // Fetch full product with all relations for re-indexing
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
      logger.warn(`[Product Indexing] product ${productId} not found for variant ${variantId}`)
      return
    }

    // AUDIT-FIX: EVT-F11 — Retry Typesense indexing on transient failures
    // Re-index to Typesense (upsert is idempotent)
    await withTypesenseRetry(
      () => indexProduct(product),
      `indexProduct(${product.id}, variant-update)`,
      logger,
    )

    // Invalidate all query caches — price data changed
    const flushed = await invalidateAllQueryCache()
    logger.info(`[Product Indexing] Flushed ${flushed} query cache entries`)

    // Force re-embedding on next query (clear stale cached embedding)
    await deleteEmbeddingCache(product.id)

    // AUDIT-FIX: EVT-F04 — Removed dead product.indexed NATS event (no subscriber existed)

    logger.info(`[Product Indexing] Re-indexed after variant update: ${product.id} (${product.title})`)
  } catch (error) {
    logger.error(`[Product Indexing] variant-updated handler failed for ${data.id}:`, error instanceof Error ? error : new Error(String(error)))
  }
}

export const config: SubscriberConfig = {
  event: "product-variant.updated",
}
