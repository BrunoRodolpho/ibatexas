// add_to_cart tool — add a product variant to the Medusa cart

import { AddToCartInputSchema, type AddToCartInput, type AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";
import { publishNatsEvent } from "@ibatexas/nats-client";

export async function addToCart(
  input: AddToCartInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = AddToCartInputSchema.parse(input);

  let data: unknown;
  try {
    data = await medusaStoreFetch(`/store/carts/${parsed.cartId}/line-items`, {
      method: "POST",
      body: JSON.stringify({ variant_id: parsed.variantId, quantity: parsed.quantity }),
    });
  } catch (err) {
    console.error("[add_to_cart] Medusa error:", err);
    return { success: false, message: "Erro ao adicionar item ao carrinho. Verifique o produto e tente novamente." };
  }

  void publishNatsEvent("cart.item_added", {
    eventType: "cart.item_added",
    cartId: parsed.cartId,
    variantId: parsed.variantId,
    quantity: parsed.quantity,
    customerId: ctx.customerId,
    sessionId: ctx.sessionId,
  }).catch((err) => console.error("[add_to_cart] NATS publish error:", err));

  return data;
}

export const AddToCartTool = {
  name: "add_to_cart",
  description:
    "Adiciona um produto ao carrinho. Use o variantId obtido de search_products ou get_product_details.",
  inputSchema: {
    type: "object",
    properties: {
      cartId: { type: "string", description: "ID do carrinho" },
      variantId: { type: "string", description: "ID da variante do produto" },
      quantity: { type: "number", description: "Quantidade a adicionar (mínimo 1)" },
    },
    required: ["cartId", "variantId", "quantity"],
  },
} as const;
