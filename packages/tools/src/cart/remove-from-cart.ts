// remove_from_cart tool — delete a line item from the Medusa cart

import { RemoveFromCartInputSchema, type RemoveFromCartInput, type AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";

export async function removeFromCart(
  input: RemoveFromCartInput,
  _ctx: AgentContext,
): Promise<unknown> {
  const parsed = RemoveFromCartInputSchema.parse(input);
  try {
    return await medusaStoreFetch(`/store/carts/${parsed.cartId}/line-items/${parsed.itemId}`, {
      method: "DELETE",
    });
  } catch (err) {
    console.error("[remove_from_cart] Medusa error:", err);
    return { success: false, message: "Erro ao remover item do carrinho. Tente novamente." };
  }
}

export const RemoveFromCartTool = {
  name: "remove_from_cart",
  description: "Remove um item do carrinho.",
  inputSchema: {
    type: "object",
    properties: {
      cartId: { type: "string" },
      itemId: { type: "string", description: "ID do item no carrinho" },
    },
    required: ["cartId", "itemId"],
  },
} as const;
