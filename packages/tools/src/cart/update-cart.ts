// update_cart tool — update a line item quantity in the Medusa cart

import { UpdateCartInputSchema, type UpdateCartInput, type AgentContext } from "@ibatexas/types";
import {
  medusaStoreAdjudicated,
  MedusaStoreAdjudicateRefusedError,
} from "../medusa/store-adjudicated.js";
import { assertCartOwnership } from "./assert-cart-ownership.js";

export async function updateCart(
  input: UpdateCartInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = UpdateCartInputSchema.parse(input);
  await assertCartOwnership(parsed.cartId, ctx.customerId);
  try {
    return await medusaStoreAdjudicated.carts.lineItems.update(
      {
        cartId: parsed.cartId,
        itemId: parsed.itemId,
        quantity: parsed.quantity,
      },
      {
        sourceSubject: "cart:update-cart",
        actorPrincipal: "llm",
        ...(ctx.customerId !== undefined ? { customerId: ctx.customerId } : {}),
        sessionId: ctx.sessionId,
      },
    );
  } catch (err) {
    // audit-2026-05-24 P2-2: kernel REFUSE attaches a kind-specific pt-BR
    // userFacing copy — surface it instead of the generic fallback.
    if (err instanceof MedusaStoreAdjudicateRefusedError) {
      return { success: false, message: err.userFacing };
    }
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
