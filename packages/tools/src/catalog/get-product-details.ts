// get_product_details tool: fetch a single product from Typesense by ID

import type { ProductDTO } from "@ibatexas/types"
import { getTypesenseClient, COLLECTION } from "../typesense/client.js"
import { typesenseDocToDTO, type TypesenseProductDoc } from "../mappers/product-mapper.js"
import { publishNatsEvent } from "@ibatexas/nats-client"

/**
 * Retrieve full product details by ID from Typesense.
 * Publishes a product.viewed NATS event (non-blocking) when customerId is provided.
 * Returns null if the product is not found.
 */
export async function getProductDetails(productId: string, customerId?: string): Promise<ProductDTO | null> {
  const client = getTypesenseClient()
  try {
    const doc = await client.collections<TypesenseProductDoc>(COLLECTION).documents(productId).retrieve()
    const product = typesenseDocToDTO(doc)

    // Non-blocking: publish product.viewed for customer intelligence
    void publishNatsEvent("product.viewed", {
      eventType: "product.viewed",
      productId,
      customerId: customerId ?? null,
      timestamp: new Date().toISOString(),
    }).catch(() => {
      // Swallow — NATS event is non-critical
    })

    return product
  } catch (err: unknown) {
    // Typesense 404 (ObjectNotFound) → return null
    if (err && typeof err === "object" && "httpStatus" in err && (err as Record<string, unknown>).httpStatus === 404) {
      return null
    }
    // All other errors (network, auth, server) → rethrow
    throw err
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const GetProductDetailsTool = {
  name: "get_product_details",
  description:
    "Busca detalhes completos de um produto pelo ID: galeria de imagens, variantes, informações nutricionais, alérgenos e produtos relacionados. Use após search_products para exibir detalhes de um produto específico.",
  inputSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "ID do produto retornado por search_products",
      },
    },
    required: ["productId"],
  },
}
