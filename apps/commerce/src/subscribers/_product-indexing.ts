/**
 * Shared product-fetch-and-index logic for product subscribers.
 */

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { indexProduct } from "@ibatexas/tools"

const PRODUCT_FIELDS = [
  "*",
  "variants.*",
  "variants.price_set.*",
  "variants.price_set.prices.*",
  "tags.*",
  "categories.*",
  "images.*",
] as const

// AUDIT-FIX: EVT-F11 — Max retry attempts for Typesense indexing failures
const TYPESENSE_MAX_RETRIES = 2

interface MedusaContainer {
  resolve(key: string): any
}

/**
 * AUDIT-FIX: EVT-F11 — Retry wrapper with exponential backoff for Typesense operations.
 * Max 2 retries (3 total attempts) with 500ms base delay.
 */
async function withTypesenseRetry<T>(
  fn: () => Promise<T>,
  label: string,
  logger: { warn: (...args: any[]) => void },
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= TYPESENSE_MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < TYPESENSE_MAX_RETRIES) {
        const delayMs = 500 * Math.pow(2, attempt) // 500ms, 1000ms
        logger.warn(
          `[Product Indexing] ${label} attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

export async function fetchAndIndexProduct(
  productId: string,
  container: MedusaContainer,
  action: "created" | "updated",
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve("logger")
  const { data: products } = await query.graph({
    entity: "product",
    fields: [...PRODUCT_FIELDS],
    filters: { id: productId },
  })
  const product = products[0]
  if (!product) return null

  // AUDIT-FIX: EVT-F11 — Retry Typesense indexing on transient failures
  await withTypesenseRetry(
    () => indexProduct(product),
    `indexProduct(${productId}, ${action})`,
    logger,
  )

  // AUDIT-FIX: EVT-F04 — Removed dead product.indexed NATS event (no subscriber existed)

  return product
}

// Re-export for use in subscribers that call Typesense directly
export { withTypesenseRetry }
