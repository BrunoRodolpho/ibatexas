// admin/ops-snapshot.ts — manager-gated ops situational-snapshot (NEW-040).
//
// A single READ-ONLY manager-awareness endpoint that COMPOSES the four ops
// signals built this session — it introduces NO model, NO migration, NO
// mutation and reimplements NO read:
//
//   GET /api/admin/ops/snapshot → OpsSnapshot {
//     now, opsAlerts:{open,bySeverity}, incidents:{open},
//     kitchen:{activeTickets,oldestTicketAgeMs,queueDepth}, caixa:{…headline}
//   }
//
// The composition itself lives in the shared `composeOpsSnapshot` (ops/ops-
// snapshot-compose.ts) so ONE implementation backs BOTH this route AND the
// NEW-032 ops-actor conductor's `ops_snapshot` READ tool. This route is now
// the thin HTTP shell: lazy service construction + a `requireManagerRole`
// preHandler that fail-closes 403 + the shared composer.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createOpsAlertService,
  createIncidentService,
  createKitchenService,
  createDayCloseService,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { todayInRestaurantTz } from "./_date-defaults.js";
import { composeOpsSnapshot } from "../../ops/ops-snapshot-compose.js";

export async function adminOpsSnapshotRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting
  // the admin plugin with a partial `@ibatexas/domain` mock doesn't trip over a
  // missing factory at register time (mirrors kitchen.ts / ops-alerts.ts).
  let opsAlertSvc: ReturnType<typeof createOpsAlertService> | undefined;
  let incidentSvc: ReturnType<typeof createIncidentService> | undefined;
  let kitchenSvc: ReturnType<typeof createKitchenService> | undefined;
  let dayCloseSvc: ReturnType<typeof createDayCloseService> | undefined;
  const opsAlerts = () => (opsAlertSvc ??= createOpsAlertService({ auditSink: getAuditSink() }));
  const incidents = () => (incidentSvc ??= createIncidentService());
  const kitchen = () => (kitchenSvc ??= createKitchenService());
  const dayClose = () => (dayCloseSvc ??= createDayCloseService());

  // ── GET /api/admin/ops/snapshot — the composed situational overview ─────────
  app.get(
    "/api/admin/ops/snapshot",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Panorama operacional (alertas, incidentes, cozinha, caixa)",
      },
    },
    async (request, reply) => {
      const snapshot = await composeOpsSnapshot({
        opsAlerts,
        incidents,
        kitchen,
        dayClose,
        today: todayInRestaurantTz(),
        log: request.log,
      });
      return reply.send(snapshot);
    },
  );
}
