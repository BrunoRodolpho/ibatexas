// cancel_order tool — cancel a Medusa order if eligible

import { CancelOrderInputSchema, NonRetryableError, type CancelOrderInput, type AgentContext } from "@ibatexas/types";
import { createOrderService } from "@ibatexas/domain";
import { medusaAdmin } from "../medusa/client.js";

export async function cancelOrder(
  input: CancelOrderInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  const parsed = CancelOrderInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para cancelar pedido.");
  }

  const svc = createOrderService(medusaAdmin);
  return svc.cancelOrder(parsed.orderId, ctx.customerId);
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
