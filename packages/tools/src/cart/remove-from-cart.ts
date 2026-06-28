// remove_from_cart tool — delete a line item from the Medusa cart

import { RemoveFromCartInputSchema, type RemoveFromCartInput, type AgentContext } from "@ibatexas/types";
import { getAuditSink } from "@ibatexas/audit-sink";
import {
  medusaStoreAdjudicated,
  MedusaStoreAdjudicateRefusedError,
} from "../medusa/store-adjudicated.js";
import { assertCartOwnership } from "./assert-cart-ownership.js";

export async function removeFromCart(
  input: RemoveFromCartInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = RemoveFromCartInputSchema.parse(input);
  await assertCartOwnership(parsed.cartId, ctx.customerId);
  try {
    return await medusaStoreAdjudicated.carts.lineItems.remove(
      {
        cartId: parsed.cartId,
        itemId: parsed.itemId,
      },
      {
        sourceSubject: "cart:remove-from-cart",
        actorPrincipal: "llm",
        auditSink: getAuditSink(),
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
    console.error("[remove_from_cart] Medusa error:", (err as Error).message);
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
