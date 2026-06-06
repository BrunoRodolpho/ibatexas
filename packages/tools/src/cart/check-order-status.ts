// check_order_status tool — fetch Medusa order with status + fulfillment

import { CheckOrderStatusInputSchema, NonRetryableError, type CheckOrderStatusInput, type AgentContext } from "@ibatexas/types";
import { withOrderOwnership } from "../guards/with-ownership.js";
import { createTooledOrderService } from "./_shared.js";

async function checkOrderStatusImpl(
  input: CheckOrderStatusInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = CheckOrderStatusInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para verificar status de pedido.");
  }

  // W8-V1: wired through the shared factory even though only svc.getOrder
  // (a GET) is exercised today. The factory satisfies the hard-throw gate
  // in order.service.ts and removes the bare-medusaAdmin posture.
  const svc = createTooledOrderService("tool:check_order_status");
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
