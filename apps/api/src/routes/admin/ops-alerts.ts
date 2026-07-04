// admin/ops-alerts.ts — the ops-alert inbox (NEW-025 / BKL-081). Manager-gated
// REST surface over the OpsAlertService: list the deterministic ops watchdogs'
// alerts (stuck orders, PIX-expiry backlog, stale defers, DLQ depth) + a governed
// STAFF resolve. Mirrors admin/incidents.ts; every route fail-closes to 403 via
// `requireManagerRole`. The future ops agent (NEW-032) consumes the SAME store.
//
// Governance: the resolve is a SYSTEM-actor `ops.alert.resolve` IntentEnvelope
// (buildSystemEnvelope) through the SYSTEM-only ops-alert policy bundle — the
// staff identity rides the payload (resolvedBy / resolutionType STAFF), exactly
// like the incident staff-resolve (CLAUDE.md #9).

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createOpsAlertService,
  type OpsAlertResolvePayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { buildSystemEnvelope } from "../../subscribers/__shared__/system-actor-envelope.js";

// The ops-cause / status taxonomies (mirror the frozen enums in the domain
// ops-alert plane: FROZEN_OPS_CAUSES + the OpsAlertStatus Prisma enum).
const OpsCause = z.enum([
  "ops_stuck_order",
  "ops_pix_expiry_backlog",
  "ops_stale_defer",
  "ops_dlq_depth",
  "ops_ingredient_underflow",
]);
const OpsStatus = z.enum(["OPEN", "ACKNOWLEDGED", "AUTO_RESOLVED", "RESOLVED"]);

const ListQuery = z.object({
  status: OpsStatus.optional(),
  cause: OpsCause.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function adminOpsAlertRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting the
  // admin plugin with a partial `@ibatexas/domain` mock doesn't trip over a missing
  // factory at register time (mirrors incidents.ts / conversations.ts).
  let opsAlertSvc: ReturnType<typeof createOpsAlertService> | undefined;
  const svc = () => (opsAlertSvc ??= createOpsAlertService({ auditSink: getAuditSink() }));

  // ── GET /api/admin/ops-alerts — list + independent open-count badge ──────────
  app.get(
    "/api/admin/ops-alerts",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Alertas operacionais (lista + contagem de abertos)",
        querystring: ListQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof ListQuery>;
      const { alerts, openCount } = await svc().list({
        ...(q.status ? { status: q.status } : {}),
        ...(q.cause ? { cause: q.cause } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      });
      // openCount is the INDEPENDENT NON_TERMINAL count (OPEN + ACKNOWLEDGED),
      // never alerts.length — it backs the inbox badge under any list filter.
      return reply.send({ alerts, openCount });
    },
  );

  // ── POST /api/admin/ops-alerts/:id/resolve — governed STAFF resolve ──────────
  app.post(
    "/api/admin/ops-alerts/:id/resolve",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Resolver um alerta operacional (fechamento manual)",
        params: z.object({ id: z.string().min(1).max(256) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const staffId = request.staffId ?? null;
      const resolvedBy = staffId ? `staff:${staffId}` : "admin-key";

      const payload: OpsAlertResolvePayload = {
        id,
        resolvedBy,
        resolutionType: "STAFF",
      };
      const envelope = buildSystemEnvelope({
        kind: "ops.alert.resolve" as const,
        payload,
        sourceSubject: "ops.alert.staff_resolve",
        eventId: `${id}:resolve:${Date.now()}`,
      });
      const out = await svc().resolveAlertFromEnvelope(envelope, {});
      const alert = out.result ?? null;

      // 404 ONLY when the id does not exist (resolveExecutor returns null). An
      // already-terminal row returns the current row → 200 (idempotent; avoids the
      // second-click / race 404).
      if (!alert) {
        return reply.code(404).send({ error: "ops_alert_not_found" });
      }
      return reply.send({ alert });
    },
  );
}
