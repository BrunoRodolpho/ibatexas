// get_cart tool — fetch the current Medusa cart from session

import { GetCartInputSchema, type GetCartInput, type AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";
import { assertCartOwnership } from "./assert-cart-ownership.js"; // AUDIT-FIX: TOOL-C02

export async function getCart(
  input: GetCartInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = GetCartInputSchema.parse(input);
  // AUDIT-FIX: TOOL-C02 — verify cart ownership before returning data
  await assertCartOwnership(parsed.cartId, ctx.customerId);
  return medusaStoreFetch(`/store/carts/${parsed.cartId}`);
}

export const GetCartTool = {
  name: "get_cart",
  description: "Busca o carrinho atual do cliente com itens, quantidades e totais.",
  inputSchema: {
    type: "object",
    properties: {
      cartId: { type: "string", description: "ID do carrinho Medusa" },
    },
    required: ["cartId"],
  },
} as const;
