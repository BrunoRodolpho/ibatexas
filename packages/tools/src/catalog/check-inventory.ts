// check_inventory tool
// Queries Medusa admin API for variant inventory and returns availability status.

import type { CheckInventoryInput, CheckInventoryOutput } from "@ibatexas/types"
import { CheckInventoryInputSchema } from "@ibatexas/types"
import { medusaAdmin } from "../medusa/client.js"

interface InventoryItem {
  stocked_quantity: number
}

interface InventoryListResponse {
  inventory_items: InventoryItem[]
}

export async function checkInventory(input: CheckInventoryInput): Promise<CheckInventoryOutput> {
  const response = (await medusaAdmin(
    `/admin/inventory-items?variant_id=${encodeURIComponent(input.variantId)}`,
  )) as InventoryListResponse

  const item = response.inventory_items[0]
  const quantity = item?.stocked_quantity ?? 0

  return {
    available: quantity > 0,
    quantity,
    nextAvailableAt: null,
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const CheckInventoryTool = {
  name: "check_inventory",
  description:
    "Verifica a disponibilidade de estoque de uma variante de produto",
  inputSchema: CheckInventoryInputSchema,
} as const
