import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { medusaAdmin } from "./_shared.js";

const OrdersAdminQuery = z.object({
  status: z.string().optional(),
  payment_status: z.string().optional(),
  fulfillment_status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const OrderParams = z.object({ id: z.string().min(1) });

const OrderPatchBody = z.object({
  fulfillment_status: z.string().optional(),
  payment_status: z.string().optional(),
});

export async function orderRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/admin/orders ──────────────────────────────────────────────────
  app.get(
    "/api/admin/orders",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar pedidos (admin)",
        querystring: OrdersAdminQuery,
      },
    },
    async (request, reply) => {
      const { status, payment_status, fulfillment_status, limit, offset } =
        request.query;

      const qs = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        fields:
          "id,display_id,email,customer,items,total,status,payment_status,fulfillment_status,created_at",
        expand: "items,customer",
      });
      if (status) qs.set("status[]", status);
      if (payment_status) qs.set("payment_status[]", payment_status);
      if (fulfillment_status) qs.set("fulfillment_status[]", fulfillment_status);

      try {
        const data = await medusaAdmin(`/admin/orders?${qs}`);
        return reply.send({ orders: data.orders ?? [], count: data.count ?? 0 });
      } catch (err) {
        server.log.error(err, "Failed to fetch orders from Medusa");
        reply.code(502).send({ error: "Failed to fetch orders from Medusa" });
      }
    },
  );

  // ── PATCH /api/admin/orders/:id ───────────────────────────────────────────
  app.patch(
    "/api/admin/orders/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Atualizar pedido (admin)",
        params: OrderParams,
        body: OrderPatchBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      try {
        const data = await medusaAdmin(`/admin/orders/${id}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return reply.send({ order: data.order });
      } catch (err) {
        server.log.error(err, "Failed to update order");
        reply.code(502).send({ error: "Failed to update order" });
      }
    },
  );
}
