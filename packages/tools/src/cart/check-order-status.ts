// check_order_status tool — fetch Medusa order with status + fulfillment

import type { AgentContext } from "@ibatexas/types";
import { medusaAdminFetch } from "./_shared.js";

export async function checkOrderStatus(
  input: { orderId: string },
  ctx: AgentContext,
): Promise<unknown> {
  if (!ctx.customerId) {
    throw new Error("Autenticação necessária para verificar status de pedido.");
  }

  let data: { order: { customer_id?: string; metadata?: Record<string, string> } };
  try {
    data = await medusaAdminFetch(`/admin/orders/${input.orderId}`) as typeof data;
  } catch {
    return { success: false, message: "Erro ao buscar pedido. Tente novamente." };
  }

  const order = data.order;

  // Verify the order belongs to the authenticated customer (LGPD compliance)
  const orderCustomerId =
    order.customer_id ?? order.metadata?.["customerId"];

  if (orderCustomerId && orderCustomerId !== ctx.customerId) {
    return { success: false, message: "Pedido não encontrado." };
  }

  return data;
}

export const CheckOrderStatusTool = {
  name: "check_order_status",
  description: "Verifica o status de um pedido específico, incluindo informações de entrega.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido" },
    },
    required: ["orderId"],
  },
} as const;
