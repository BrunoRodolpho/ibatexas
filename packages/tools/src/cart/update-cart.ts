// update_cart tool — update a line item quantity in the Medusa cart

import { UpdateCartInputSchema, type UpdateCartInput, type AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";
import { assertCartOwnership } from "./assert-cart-ownership.js"; // AUDIT-FIX: TOOL-C02

export async function updateCart(
  input: UpdateCartInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = UpdateCartInputSchema.parse(input);
  // AUDIT-FIX: TOOL-C02 — verify cart ownership before modifying
  await assertCartOwnership(parsed.cartId, ctx.customerId);
  try {
    return await medusaStoreFetch(`/store/carts/${parsed.cartId}/line-items/${parsed.itemId}`, {
      method: "POST",
      body: JSON.stringify({ quantity: parsed.quantity }),
    });
  } catch (err) {
    console.error("[update_cart] Medusa error:", (err as Error).message);
    return { success: false, message: "Erro ao atualizar item no carrinho. Tente novamente." };
  }
}

export const UpdateCartTool = {
  name: "update_cart",
  description: "Atualiza a quantidade de um item no carrinho.",
  inputSchema: {
    type: "object",
    properties: {
      cartId: { type: "string" },
      itemId: { type: "string", description: "ID do item no carrinho (line item ID)" },
      quantity: { type: "number", description: "Nova quantidade" },
    },
    required: ["cartId", "itemId", "quantity"],
  },
} as const;
