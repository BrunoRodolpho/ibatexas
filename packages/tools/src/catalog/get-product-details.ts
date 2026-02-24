// get_product_details tool: fetch a single product from Typesense by ID

import type { ProductDTO } from "@ibatexas/types"
import { getTypesenseClient, COLLECTION } from "../typesense/client.js"
import { typesenseDocToDTO } from "../mappers/product-mapper.js"

/**
 * Retrieve full product details by ID from Typesense.
 * Returns null if the product is not found.
 */
export async function getProductDetails(productId: string): Promise<ProductDTO | null> {
  const client = getTypesenseClient()
  try {
    const doc = await client.collections(COLLECTION).documents(productId).retrieve()
    return typesenseDocToDTO(doc as Record<string, unknown>)
  } catch {
    return null
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
