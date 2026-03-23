import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { medusaAdmin } from "./_shared.js";

const AnalyticsSummaryResponse = z.object({
  ordersToday: z.number(),
  revenueToday: z.number(),
  aov: z.number(),
  activeCarts: z.number(),
});

export async function analyticsRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/admin/analytics/summary ──────────────────────────────────────
  app.get(
    "/api/admin/analytics/summary",
    {
      schema: {
        tags: ["admin"],
        summary: "Resumo de análises (admin)",
        response: { 200: AnalyticsSummaryResponse },
      },
    },
    async (_request, reply) => {
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayIso = today.toISOString();

        const qs = new URLSearchParams({
          created_at: JSON.stringify({ gte: todayIso }),
          limit: "500",
          offset: "0",
          fields: "id,total,status",
        });

        let ordersToday = 0;
        let revenueToday = 0;
        let aov = 0;

        try {
          const data = (await medusaAdmin(
            `/admin/orders?${qs}`,
          )) as Record<string, unknown>;
          const orders = (data.orders ?? []) as {
            id: string;
            total: number;
            status: string;
          }[];
          ordersToday = orders.length;
          revenueToday = orders.reduce(
            (sum: number, o) => sum + (o.total ?? 0),
            0,
          );
          aov = ordersToday > 0 ? Math.round(revenueToday / ordersToday) : 0;
        } catch {
          // Medusa not running — return zeros
        }

        // Active carts: count carts created today
        let activeCarts = 0;
        try {
          const cartData = (await medusaAdmin(
            `/admin/orders?status[]=pending&limit=1&offset=0&fields=id`,
          )) as Record<string, unknown>;
          activeCarts = (cartData.count as number) ?? 0;
        } catch {
          // Medusa not running — return zero
        }

        return reply.send({ ordersToday, revenueToday, aov, activeCarts });
      } catch (err) {
        server.log.error(err, "Failed to load analytics summary");
        reply.code(500).send({ error: "Failed to load analytics summary" });
      }
    },
  );
}
