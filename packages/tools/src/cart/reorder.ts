// reorder tool — create a new cart from a previous order's items

import { ReorderInputSchema, NonRetryableError, type ReorderInput, type AgentContext } from "@ibatexas/types";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { withOrderOwnership } from "../guards/with-ownership.js";
import { medusaAdminFetch, medusaStoreFetch } from "./_shared.js";
import { toolLog } from "../logger.js";

const log = toolLog("tools:cart");

async function reorderImpl(
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

  // P2-PERF-REORDER: add line-items in parallel instead of one HTTP call at a
  // time. Each add is independent (Medusa keys line-items by variant), so a
  // failure on one must not block the others — Promise.allSettled collects per
  // -item outcomes and we keep the existing partial-success error note.
  const addableItems = items.filter((item) => item.variant_id);
  const results = await Promise.allSettled(
    addableItems.map((item) =>
      medusaStoreFetch(`/store/carts/${cartId}/line-items`, {
        method: "POST",
        body: JSON.stringify({ variant_id: item.variant_id, quantity: item.quantity }),
      }),
    ),
  );

  const errors: string[] = [];
  results.forEach((result, idx) => {
    if (result.status === "rejected") {
      errors.push(addableItems[idx].title);
    }
  });

  // TODO: Add subscriber for cart.item_added when cart analytics pipeline is built
  void publishNatsEvent("cart.item_added", {
    eventType: "cart.item_added",
    cartId,
    customerId: ctx.customerId,
    sessionId: ctx.sessionId,
    reorderFromOrderId: parsed.orderId,
  }).catch((err) => log.error({ err: (err as Error).message }, "reorder: NATS publish error"));

  const errorNote = errors.length > 0 ? ` (item(ns) indisponível(is): ${errors.join(", ")})` : "";
  return {
    cartId,
    message: `Carrinho criado com os itens do pedido anterior${errorNote}. CartId: ${cartId}`,
  };
}

// SEC-002: Ownership guard wrapper — rejects before any business logic
export const reorder = withOrderOwnership(reorderImpl);

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
