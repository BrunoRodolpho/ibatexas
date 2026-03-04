// remove_from_cart tool — delete a line item from the Medusa cart

import type { AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";

export async function removeFromCart(
  input: { cartId: string; itemId: string },
  _ctx: AgentContext,
): Promise<unknown> {
  try {
    return await medusaStoreFetch(`/store/carts/${input.cartId}/line-items/${input.itemId}`, {
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
