// check_order_status tool — fetch Medusa order with status + fulfillment

import { CheckOrderStatusInputSchema, NonRetryableError, type CheckOrderStatusInput, type AgentContext } from "@ibatexas/types";
import { createOrderService } from "@ibatexas/domain";
import { medusaAdmin } from "../medusa/client.js";

export async function checkOrderStatus(
  input: CheckOrderStatusInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = CheckOrderStatusInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para verificar status de pedido.");
  }

  const svc = createOrderService(medusaAdmin);
  const { order, ownershipValid } = await svc.getOrder(parsed.orderId, ctx.customerId);

  if (!ownershipValid) {
    return { success: false, message: "Pedido não encontrado." };
  }

  return { order };
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
