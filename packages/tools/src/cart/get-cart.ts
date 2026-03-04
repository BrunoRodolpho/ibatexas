// get_cart tool — fetch the current Medusa cart from session

import type { AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";

export async function getCart(
  input: { cartId: string },
  _ctx: AgentContext,
): Promise<unknown> {
  return medusaStoreFetch(`/store/carts/${input.cartId}`);
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
