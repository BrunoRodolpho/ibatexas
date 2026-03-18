// update_cart tool — update a line item quantity in the Medusa cart

import { UpdateCartInputSchema, type UpdateCartInput, type AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";

export async function updateCart(
  input: UpdateCartInput,
  _ctx: AgentContext,
): Promise<unknown> {
  const parsed = UpdateCartInputSchema.parse(input);
  try {
    return await medusaStoreFetch(`/store/carts/${parsed.cartId}/line-items/${parsed.itemId}`, {
      method: "POST",
      body: JSON.stringify({ quantity: parsed.quantity }),
    });
  } catch (err) {
    console.error("[update_cart] Medusa error:", err);
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
