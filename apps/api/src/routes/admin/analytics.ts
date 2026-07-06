import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { prisma } from "@ibatexas/domain";
import { getRedisClient } from "@ibatexas/tools";
import { composeSalesAnalytics } from "../../ops/sales-analytics-compose.js";
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
  // BKL-128 — the composer signals that FAILED and fell back to zeros
  // ("orders" | "activeCarts" | "newCustomers30d" | "whatsapp"). The dashboard
  // renders a degraded signal's tiles as "indisponível", never as confident
  // zeros (the BKL-100 posture; the flat DTO previously DROPPED this field).
  degraded: z.array(z.string()),
});

export async function analyticsRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/admin/analytics/summary ──────────────────────────────────────
  // Thin HTTP shell over the shared `composeSalesAnalytics` (NEW-012): ONE
  // implementation now backs BOTH this route AND the ops-actor `ops_sales_
  // analytics` READ tool. The per-signal-zeros resilience the inline handler had
  // (a try/catch per read) is preserved by the composer's Promise.allSettled +
  // fallback; the flat response contract below is unchanged (the admin panel's
  // `formatBRL` reads revenue/aov as integer centavos).
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
      const view = await composeSalesAnalytics({
        medusaAdmin: (path) => medusaAdmin(path),
        countNewCustomers: (since) =>
          prisma.customer.count({ where: { createdAt: { gte: since } } }),
        redisGet: async (key) => (await getRedisClient()).get(key),
        now: new Date(),
        log: server.log,
      });

      return reply.send({
        ordersToday: view.orders.ordersCount,
        revenueToday: view.orders.revenueCentavos,
        aov: view.orders.aovCentavos,
        activeCarts: view.activeCarts,
        newCustomers30d: view.newCustomers30d,
        outreachWeekly: view.whatsapp.outreachWeekly,
        waConversionRate: view.whatsapp.conversionRatePct,
        avgMessagesToCheckout: view.whatsapp.avgMessagesToCheckout,
        degraded: [...view.degraded],
      });
    },
  );
}
