import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { createReservationService } from "@ibatexas/domain";
import { medusaAdmin } from "./_shared.js";
import { getEscalationStore } from "../../escalation/escalation-store.js";

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
          "created_at[gte]": todayIso,
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
        } catch (err) {
          server.log.warn({ err }, "Dashboard: failed to fetch from Medusa — returning zeros")
        }

        let activeReservations = 0
        try {
          const reservationSvc = createReservationService()
          activeReservations = await reservationSvc.countActive()
        } catch (err) {
          // F-34: this arm used to carry the Medusa catch's message verbatim, so
          // a reservation outage was reported to on-call as a Medusa outage.
          // Each fail-soft arm names its OWN source; pinned by attribution (not
          // by prose) in __tests__/dashboard.test.ts.
          server.log.warn({ err }, "Dashboard: failed to count active reservations — returning 0")
        }

        // Real open-escalation count (was hard-coded 0, masking the takeover
        // queue on the dashboard). listOpen self-heals stale set members; the
        // high limit keeps the count effectively exact. Fail-soft to 0 for the
        // display metric, matching the orders/reservations handling above.
        let pendingEscalations = 0
        try {
          const escalationStore = await getEscalationStore()
          pendingEscalations = (await escalationStore.listOpen(1000)).length
        } catch (err) {
          server.log.warn({ err }, "Dashboard: failed to count open escalations — returning 0")
        }

        return reply.send({
          ordersToday,
          revenueToday,
          activeReservations,
          pendingEscalations,
        });
      } catch (err) {
        server.log.error(err, "Failed to load dashboard");
        reply.code(500).send({ error: "Failed to load dashboard" });
      }
    },
  );
}
