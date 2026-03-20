// check_order_status tool — fetch Medusa order with status + fulfillment

import { CheckOrderStatusInputSchema, NonRetryableError, type CheckOrderStatusInput, type AgentContext } from "@ibatexas/types";
import { createOrderService } from "@ibatexas/domain";
import { medusaAdmin } from "../medusa/client.js";
import { withOrderOwnership } from "../guards/with-ownership.js";

async function checkOrderStatusImpl(
  input: CheckOrderStatusInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = CheckOrderStatusInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para verificar status de pedido.");
  }

  const svc = createOrderService(medusaAdmin);
  const { order } = await svc.getOrder(parsed.orderId, ctx.customerId);

  return { order };
}

// SEC-002: Ownership guard wrapper — rejects before any business logic
export const checkOrderStatus = withOrderOwnership(checkOrderStatusImpl);

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
