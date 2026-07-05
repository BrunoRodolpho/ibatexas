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
import { deriveAgentApprovalOutcome } from "../../claustrum/agent-approvals.js";
import { requireManagerRole } from "../../middleware/staff-auth.js";

// BKL-104 — the structured resolved-outcome the resolve route returns so the
// AUT-024 UI can explain WHY a parked action was (or was NOT) executed instead
// of inferring from `decision.kind`. Mirrors the AgentApprovalOutcome contract
// in claustrum/agent-approvals.ts. `approval` is left permissive (z.unknown) so
// the full TTL'd projection passes through the serializer verbatim.
const OUTCOME_STATUS = [
  "executed",
  "rejected",
  "refused",
  "reparked",
  "escalated",
  "denied_by_kernel",
] as const;

const resolveResponseSchema = z.object({
  approval: z.unknown(),
  outcome: z.object({
    status: z.enum(OUTCOME_STATUS),
    decisionKind: z.string().optional(),
    reasonCode: z.string().optional(),
    refusalPtBr: z.string().optional(),
  }),
  // Retained for back-compat with the pre-BKL-104 shape ({ approval, decision }).
  decision: z.object({ kind: z.string() }).optional(),
});

// The resolve route's error bodies (plane-off 404 + unknown/expired token 400) —
// declared so the typed reply provider allows `reply.code(4xx).send(...)` now
// that a 200 response schema is present.
const errorResponseSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});

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
  //
  // BKL-069 Part D (SCN-120): resolving a parked agent intent is a MANAGER+ act.
  // The outer admin guard (routes/admin/index.ts) already authenticated the
  // caller and populated request.staffId/staffRole (JWT) or request.adminApiKeyRole
  // (registry key); requireManagerRole gates on that — ATTENDANT JWTs and
  // unmapped/bare API keys fail closed (403). The `list`/`get` reads above are
  // intentionally NOT tightened. See docs/architecture/defer-resume-role-contract.md.
  app.post(
    "/api/admin/agent-approvals/:token/resolve",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Aprovar ou rejeitar uma aprovação de agente (Stage-1 confirm→EXECUTE)",
        params: z.object({ token: z.string().min(1) }),
        body: z.object({ accept: z.boolean() }),
        response: {
          200: resolveResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
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
        // BKL-104: derive the honest structured outcome from the SAME kernel
        // decision the gateway returned — accept:true can re-adjudicate to a
        // NON-EXECUTE decision (REFUSE / re-park / ESCALATE) with HTTP 200, so
        // the UI must read `outcome` (which explains WHY), never assume executed.
        const outcome = deriveAgentApprovalOutcome(request.body.accept, result.decision);
        return {
          approval: result.request,
          outcome,
          // Back-compat: keep the pre-BKL-104 `decision` field for any old caller.
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
