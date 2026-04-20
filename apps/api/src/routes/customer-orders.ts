// Customer orders route — list order history for an authenticated customer.
//
// GET /api/customer/orders — returns this customer's orders from projection.
// Falls back to Medusa via getOrderHistory tool if projection is empty (backfill grace).

import type { FastifyInstance } from "fastify";
import { getOrderHistory } from "@ibatexas/tools";
import { Channel } from "@ibatexas/types";
import { createOrderQueryService, createPaymentQueryService } from "@ibatexas/domain";
import { requireAuth } from "../middleware/auth.js";

export async function customerOrderRoutes(server: FastifyInstance): Promise<void> {
  const querySvc = createOrderQueryService();
  const paymentQuerySvc = createPaymentQueryService();

  server.get(
    "/api/customer/orders",
    {
      schema: {
        tags: ["customer"],
        summary: "Historico de pedidos do cliente autenticado",
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;

      // Primary: read from projection
      const { orders, count } = await querySvc.listByCustomer(customerId, { limit: 50 });

      if (orders.length > 0) {
        // Batch-load current payments
        const payments = await Promise.all(
          orders.map((o) => paymentQuerySvc.getActiveByOrderId(o.id).catch(() => null)),
        );

        const mapped = orders.map((o, i) => {
          const cp = payments[i];
          return {
            id: o.id,
            display_id: o.displayId,
            status: o.fulfillmentStatus,
            fulfillment_status: o.fulfillmentStatus,
            payment_status: cp ? cp.status : (o.paymentStatus ?? "pending"),
            total: o.totalInCentavos,
            subtotal: o.subtotalInCentavos,
            shipping_total: o.shippingInCentavos,
            delivery_type: o.deliveryType ?? null,
            payment_method: cp ? cp.method : (o.paymentMethod ?? null),
            tip_in_centavos: o.tipInCentavos ?? 0,
            version: o.version,
            items: Array.isArray(o.itemsJson) ? o.itemsJson : [],
            created_at: o.medusaCreatedAt.toISOString(),
            currentPayment: cp ? {
              id: cp.id,
              method: cp.method,
              status: cp.status,
              amountInCentavos: cp.amountInCentavos,
              pixExpiresAt: cp.pixExpiresAt?.toISOString() ?? null,
            } : null,
            source: "projection" as const,
          };
        });
        return reply.send({ orders: mapped, count });
      }

      // Fallback: projection empty — use Medusa via tool
      server.log.warn({ customerId }, "projection_fallback_used — customer orders");
      const result = await getOrderHistory(
        {},
        {
          channel: Channel.Web,
          sessionId: request.id,
          customerId,
          userType: "customer",
        },
      );
      return reply.send(result);
    },
  );
}
