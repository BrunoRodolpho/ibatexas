// get_order_history tool — list orders for authenticated customer

import { GetOrderHistoryInputSchema, NonRetryableError, type GetOrderHistoryInput, type AgentContext } from "@ibatexas/types";
import { createCustomerService } from "@ibatexas/domain";
import { medusaAdminFetch } from "./_shared.js";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";

export async function getOrderHistory(
  input: GetOrderHistoryInput,
  ctx: AgentContext,
): Promise<unknown> {
  GetOrderHistoryInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para ver histórico de pedidos.");
  }
  try {
    // Query by our domain customerId stored in cart/order metadata.
    // This works regardless of whether the domain Customer has a medusaId linked,
    // because create-checkout always sets metadata["customerId"] = ctx.customerId.
    const byMetadata = await medusaAdminFetch(
      `/admin/orders?metadata[customerId]=${encodeURIComponent(ctx.customerId)}&limit=20`,
    ) as { orders?: unknown[]; count?: number };

    // Fallback: also try by Medusa customer_id if linked (catches orders
    // created before the metadata convention was adopted).
    let allMedusaOrders = byMetadata.orders ?? [];
    const customerSvc = createCustomerService();
    const customer = await customerSvc.getById(ctx.customerId);
    if (customer.medusaId) {
      const byCustomer = await medusaAdminFetch(
        `/admin/orders?customer_id=${customer.medusaId}&limit=20`,
      ) as { orders?: unknown[]; count?: number };

      // Merge, deduplicating by order id
      const combined = [...allMedusaOrders, ...(byCustomer.orders ?? [])];
      const seen = new Set<string>();
      allMedusaOrders = combined.filter((o) => {
        const id = (o as { id: string }).id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }

    // Also include pending PIX/card orders not yet in Medusa (webhook pending)
    const result = { orders: allMedusaOrders, count: allMedusaOrders.length };
    try {
      const redis = await getRedisClient();
      const pendingRaw = await redis.hGetAll(rk(`customer:pending-orders:${ctx.customerId}`));
      const pendingEntries = Object.values(pendingRaw)
        .map((v) => { try { return JSON.parse(v) as { paymentIntentId: string; paymentMethod: string; createdAt: string; cartId: string }; } catch { return null; } })
        .filter((e): e is NonNullable<typeof e> => e !== null);

      // Filter out entries whose PI already matches a completed order
      const completedIds = new Set((result.orders ?? []).map((o) => {
        const meta = (o as { metadata?: Record<string, string> }).metadata;
        return meta?.["stripePaymentIntentId"];
      }).filter(Boolean));

      const pendingOrders = pendingEntries
        .filter((e) => !completedIds.has(e.paymentIntentId))
        .map((e) => ({
          id: e.paymentIntentId,
          display_id: null,
          status: "pending",
          payment_status: "awaiting",
          total: 0,
          created_at: e.createdAt,
          items: [],
          metadata: { paymentMethod: e.paymentMethod, cartId: e.cartId },
          _pending: true,
        }));

      if (pendingOrders.length > 0) {
        return {
          orders: [...(result.orders ?? []), ...pendingOrders],
          count: ((result.count ?? 0) + pendingOrders.length),
        };
      }
    } catch {
      // Redis unavailable — skip pending orders
    }

    return result;
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
