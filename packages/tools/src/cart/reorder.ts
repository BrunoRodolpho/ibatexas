// reorder tool — create a new cart from a previous order's items

import { ReorderInputSchema, NonRetryableError, type ReorderInput, type AgentContext } from "@ibatexas/types";
import { medusaAdminFetch, medusaStoreFetch } from "./_shared.js";
import { publishNatsEvent } from "@ibatexas/nats-client";

export async function reorder(
  input: ReorderInput,
  ctx: AgentContext,
): Promise<{ cartId?: string; message: string }> {
  const parsed = ReorderInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para refazer pedido.");
  }

  const data = await medusaAdminFetch(`/admin/orders/${parsed.orderId}`) as {
    order: {
      customer_id?: string;
      items: Array<{ variant_id: string; quantity: number; title: string }>;
    };
  };

  // AUDIT-FIX: TOOL-H01 — verify order belongs to the authenticated customer
  if (data.order.customer_id !== ctx.customerId) {
    throw new NonRetryableError("Acesso negado: este pedido pertence a outro cliente.");
  }

  const items = data.order.items;
  if (!items || items.length === 0) {
    return { message: "Não foi possível carregar os itens do pedido anterior." };
  }

  // Create a new cart
  const cartData = await medusaStoreFetch("/store/carts", {
    method: "POST",
    body: JSON.stringify({ customer_id: ctx.customerId }),
  }) as { cart?: { id: string } };

  const cartId = cartData.cart?.id;
  if (!cartId) {
    return { message: "Erro ao criar novo carrinho." };
  }

  // Add each item
  const errors: string[] = [];
  for (const item of items) {
    if (!item.variant_id) continue;
    try {
      await medusaStoreFetch(`/store/carts/${cartId}/line-items`, {
        method: "POST",
        body: JSON.stringify({ variant_id: item.variant_id, quantity: item.quantity }),
      });
    } catch {
      errors.push(item.title);
    }
  }

  void publishNatsEvent("cart.item_added", {
    eventType: "cart.item_added",
    cartId,
    customerId: ctx.customerId,
    sessionId: ctx.sessionId,
    reorderFromOrderId: parsed.orderId,
  }).catch((err) => console.error("[reorder] NATS publish error:", err));

  const errorNote = errors.length > 0 ? ` (item(ns) indisponível(is): ${errors.join(", ")})` : "";
  return {
    cartId,
    message: `Carrinho criado com os itens do pedido anterior${errorNote}. CartId: ${cartId}`,
  };
}

export const ReorderTool = {
  name: "reorder",
  description:
    "Cria um novo carrinho com os itens de um pedido anterior para refazer o pedido. Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido anterior" },
    },
    required: ["orderId"],
  },
} as const;
