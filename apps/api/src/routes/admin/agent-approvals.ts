// Admin agent-approvals routes (WS-D1) — the staff HTTP surface for Stage-1
// managed-agent confirmations.
//
//   GET  /api/admin/agent-approvals[?status=]   — list approval projections
//   GET  /api/admin/agent-approvals/:token      — one projection
//   POST /api/admin/agent-approvals/:token/resolve { accept } — resolve it
//
// Registered UNDER adminRoutes, so it inherits the staff-JWT / admin-API-key
// guard (no extra auth here). The approval engine lives in the managed-agent
// plane (claustrum-bootstrap getAgentApprovalGateway); when the plane is not
// enabled (IBX_AGENTS_ENABLED unset) the gateway is null and these return 404.
//
// `resolve(accept:true)` re-adjudicates the IDENTICAL parked envelope through
// the audited kernel verb with the confirmation receipt — completing the
// Stage-1 confirm→EXECUTE over the wire (the gap this closes). Every kernel
// guard still runs, so a stale/rebuilt state REFUSEs rather than mis-executes.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAgentApprovalGateway } from "../../claustrum-bootstrap.js";

const PLANE_OFF = {
  statusCode: 404,
  error: "Not Found",
  message: "managed-agent plane not enabled (IBX_AGENTS_ENABLED)",
} as const;

export async function adminAgentApprovalRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/admin/agent-approvals ──────────────────────────────────────────
  app.get(
    "/api/admin/agent-approvals",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar aprovações de agente (Stage-1)",
        querystring: z.object({
          status: z.enum(["pending", "approved", "rejected"]).optional(),
        }),
      },
    },
    async (request, reply) => {
      const gw = getAgentApprovalGateway();
      if (gw === null) return reply.code(404).send(PLANE_OFF);
      const { status } = request.query;
      return { approvals: gw.list(status ? { status } : undefined) };
    },
  );

  // ── GET /api/admin/agent-approvals/:token ───────────────────────────────────
  app.get(
    "/api/admin/agent-approvals/:token",
    {
      schema: {
        tags: ["admin"],
        summary: "Detalhe de uma aprovação de agente",
        params: z.object({ token: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const gw = getAgentApprovalGateway();
      if (gw === null) return reply.code(404).send(PLANE_OFF);
      const found = gw.get(request.params.token);
      if (found === null) {
        return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "approval not found" });
      }
      return found;
    },
  );

  // ── POST /api/admin/agent-approvals/:token/resolve ──────────────────────────
  app.post(
    "/api/admin/agent-approvals/:token/resolve",
    {
      schema: {
        tags: ["admin"],
        summary: "Aprovar ou rejeitar uma aprovação de agente (Stage-1 confirm→EXECUTE)",
        params: z.object({ token: z.string().min(1) }),
        body: z.object({ accept: z.boolean() }),
      },
    },
    async (request, reply) => {
      const gw = getAgentApprovalGateway();
      if (gw === null) return reply.code(404).send(PLANE_OFF);

      // Resolver provenance (DR-6): prefer the staff identity the admin guard
      // attached; fall back to the API-key role when the key path was used.
      const resolvedBy = request.staffId
        ? {
            id: request.staffId,
            ...(request.staffRole ? { displayName: request.staffRole } : {}),
          }
        : { id: `admin-api-key:${request.adminApiKeyRole ?? "unknown"}` };

      try {
        const result = await gw.resolve({
          token: request.params.token,
          accepted: request.body.accept,
          resolvedBy,
        });
        return {
          approval: result.request,
          ...(result.decision ? { decision: { kind: result.decision.kind } } : {}),
        };
      } catch (err) {
        // Unknown/expired/already-resolved token, or no pack owns the kind.
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: (err as Error).message,
        });
      }
    },
  );
}
