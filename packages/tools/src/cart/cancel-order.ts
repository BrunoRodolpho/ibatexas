// cancel_order tool — cancel a Medusa order if eligible

import type { AgentContext } from "@ibatexas/types";
import { medusaAdminFetch } from "./_shared.js";

export async function cancelOrder(
  input: { orderId: string },
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  if (!ctx.customerId) {
    throw new Error("Autenticação necessária para cancelar pedido.");
  }

  // Fetch order and validate it belongs to this customer + is cancellable
  const data = await medusaAdminFetch(`/admin/orders/${input.orderId}`) as {
    order: { status: string; customer_id?: string; metadata?: Record<string, string> };
  };
  const order = data.order;

  const orderCustomerId =
    order.customer_id ?? order.metadata?.["customerId"];

  if (orderCustomerId && orderCustomerId !== ctx.customerId) {
    return { success: false, message: "Pedido não encontrado." };
  }

  const cancellableStatuses = ["pending", "requires_action"];
  if (!cancellableStatuses.includes(order.status)) {
    return {
      success: false,
      message: `Pedido no status "${order.status}" não pode ser cancelado. Fale com nosso atendimento.`,
    };
  }

  await medusaAdminFetch(`/admin/orders/${input.orderId}/cancel`, { method: "POST" });

  return { success: true, message: "Pedido cancelado com sucesso." };
}

export const CancelOrderTool = {
  name: "cancel_order",
  description: "Cancela um pedido. Só é possível cancelar pedidos com status pendente. Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido a cancelar" },
    },
    required: ["orderId"],
  },
} as const;
