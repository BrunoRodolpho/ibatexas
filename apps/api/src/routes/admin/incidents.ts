// Admin incidents — Phase 1 minimal open-count REST.
//
// GET /api/admin/incidents?status=OPEN&limit=1 — manager+; returns the
// independent open-incident count that backs the persistent sidebar badge.
//
// SCOPE: Phase 1 ships ONLY the open-count read. The full inbox (list/detail/
// resolve/reply) lands in a later wave.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createIncidentService } from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { requireManagerRole } from "../../middleware/staff-auth.js";

const IncidentsQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function adminIncidentRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Open-incident count for the in-app badge (manager+ — fail-closes 403).
  app.get(
    "/api/admin/incidents",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Contagem de incidentes abertos (badge)",
        querystring: IncidentsQuery,
      },
    },
    async (request, reply) => {
      void (request.query as z.infer<typeof IncidentsQuery>);
      const svc = createIncidentService({ auditSink: getAuditSink() });
      const openCount = await svc.countOpen();
      return reply.send({ openCount });
    },
  );
}
