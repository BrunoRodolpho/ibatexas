/**
 * Shared product-fetch-and-index logic for product subscribers.
 */

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { indexProduct } from "@ibatexas/tools"
import { publishNatsEvent } from "@ibatexas/nats-client"

const PRODUCT_FIELDS = [
  "*",
  "variants.*",
  "variants.price_set.*",
  "variants.price_set.prices.*",
  "tags.*",
  "categories.*",
  "images.*",
] as const

interface MedusaContainer {
  resolve(key: string): any
}

export async function fetchAndIndexProduct(
  productId: string,
  container: MedusaContainer,
  action: "created" | "updated",
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: products } = await query.graph({
    entity: "product",
    fields: [...PRODUCT_FIELDS],
    filters: { id: productId },
  })
  const product = products[0]
  if (!product) return null

  await indexProduct(product)

  await publishNatsEvent("product.indexed", {
    productId: product.id,
    action,
    title: product.title,
    timestamp: new Date().toISOString(),
  })

  return product
}
