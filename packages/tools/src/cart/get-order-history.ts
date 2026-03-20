// get_order_history tool — list orders for authenticated customer

import { GetOrderHistoryInputSchema, NonRetryableError, type GetOrderHistoryInput, type AgentContext } from "@ibatexas/types";
import { medusaAdminFetch } from "./_shared.js";

export async function getOrderHistory(
  input: GetOrderHistoryInput,
  ctx: AgentContext,
): Promise<unknown> {
  GetOrderHistoryInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para ver histórico de pedidos.");
  }
  try {
    // Medusa Admin API — filter by customer's medusa_id
    // Customers synced during OTP verify; customerId is our domain ID
    return await medusaAdminFetch(`/admin/orders?customer_id=${ctx.customerId}&limit=20`);
  } catch (err) {
    console.error("[get_order_history] Medusa error:", (err as Error).message);
    return { success: false, message: "Erro ao buscar histórico de pedidos. Tente novamente." };
  }
}

export const GetOrderHistoryTool = {
  name: "get_order_history",
  description: "Lista os pedidos anteriores do cliente. Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
} as const;
