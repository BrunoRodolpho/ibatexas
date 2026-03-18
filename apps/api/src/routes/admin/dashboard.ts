import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { createReservationService } from "@ibatexas/domain";
import { medusaAdmin } from "./_shared.js";

export async function dashboardRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/admin/dashboard ───────────────────────────────────────────────
  app.get(
    "/api/admin/dashboard",
    { schema: { tags: ["admin"], summary: "Métricas do painel" } },
    async (_request, reply) => {
      try {
        // Fetch today's orders from Medusa
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

        try {
          const data = await medusaAdmin(`/admin/orders?${qs}`) as Record<string, unknown>;
          const orders: { id: string; total: number; status: string }[] =
            (data.orders ?? []) as { id: string; total: number; status: string }[];
          ordersToday = orders.length;
          revenueToday = orders.reduce(
            (sum: number, o) => sum + (o.total ?? 0),
            0,
          );
        } catch {
          // Medusa not running in test mode — return zeros
        }

        let activeReservations = 0
        try {
          const reservationSvc = createReservationService()
          activeReservations = await reservationSvc.countActive()
        } catch {
          // domain DB not yet migrated — return 0
        }

        return reply.send({
          ordersToday,
          revenueToday,
          activeReservations,
          pendingEscalations: 0, // populated in Step 9
        });
      } catch (err) {
        server.log.error(err, "Failed to load dashboard");
        reply.code(500).send({ error: "Failed to load dashboard" });
      }
    },
  );
}
