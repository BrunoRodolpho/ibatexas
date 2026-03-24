// get_nutritional_info tool: fetch ANVISA-format nutritional data for a product

import type { NutritionalInfo, GetNutritionalInfoInput } from "@ibatexas/types"
import { GetNutritionalInfoInputSchema } from "@ibatexas/types"
import { medusaAdmin } from "../medusa/client.js"

/**
 * Retrieve nutritional info (ANVISA format) for a product from Medusa metadata.
 * Returns null if the product has no nutritional data.
 */
export async function getNutritionalInfo(
  input: GetNutritionalInfoInput,
): Promise<NutritionalInfo | null> {
  const parsed = GetNutritionalInfoInputSchema.parse(input)

  const data = (await medusaAdmin(`/admin/products/${parsed.productId}`)) as {
    product: { metadata?: Record<string, unknown> }
  }

  const info = data.product?.metadata?.nutritionalInfo as NutritionalInfo | undefined
  return info ?? null
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const GetNutritionalInfoTool = {
  name: "get_nutritional_info",
  description:
    "Retorna informações nutricionais no formato ANVISA para um produto",
  inputSchema: GetNutritionalInfoInputSchema,
}
