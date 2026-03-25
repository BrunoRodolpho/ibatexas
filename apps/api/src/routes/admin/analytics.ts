import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { prisma } from "@ibatexas/domain";
import { getRedisClient, rk } from "@ibatexas/tools";
import { medusaAdmin } from "./_shared.js";

const AnalyticsSummaryResponse = z.object({
  ordersToday: z.number(),
  revenueToday: z.number(),
  aov: z.number(),
  activeCarts: z.number(),
  newCustomers30d: z.number(),
  outreachWeekly: z.number(),
  waConversionRate: z.number(),
  avgMessagesToCheckout: z.number(),
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

      // New customers in last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      let newCustomers30d = 0;
      try {
        newCustomers30d = await prisma.customer.count({
          where: { createdAt: { gte: thirtyDaysAgo } },
        });
      } catch {
        // DB not available — return zero
      }

      // Weekly outreach count + WA conversion metrics from Redis
      let outreachWeekly = 0;
      let waConversionRate = 0;
      let avgMessagesToCheckout = 0;
      try {
        const redis = await getRedisClient();
        const todayDateStr = new Date().toISOString().slice(0, 10);
        const [outreachVal, convsVal, waOrdersVal, avgMsgsVal] = await Promise.all([
          redis.get(rk("outreach:weekly:count")),
          redis.get(rk(`metrics:conversations:daily:${todayDateStr}`)),
          redis.get(rk(`metrics:wa_orders:daily:${todayDateStr}`)),
          redis.get(rk("metrics:avg_messages_to_checkout")),
        ]);
        outreachWeekly = outreachVal ? parseInt(outreachVal, 10) : 0;
        const conversations = convsVal ? parseInt(convsVal, 10) : 0;
        const waOrders = waOrdersVal ? parseInt(waOrdersVal, 10) : 0;
        waConversionRate = conversations > 0 ? Math.round((waOrders / conversations) * 100) : 0;
        avgMessagesToCheckout = avgMsgsVal ? Math.round(parseFloat(avgMsgsVal)) : 0;
      } catch {
        // Redis not available — return zeros
      }

      return reply.send({ ordersToday, revenueToday, aov, activeCarts, newCustomers30d, outreachWeekly, waConversionRate, avgMessagesToCheckout });
    },
  );
}
