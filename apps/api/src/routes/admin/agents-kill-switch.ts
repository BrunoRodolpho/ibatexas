// admin/agents-kill-switch.ts — BKL-098. The OPERATOR SURFACE for the per-agent
// kill switch (the emergency brake for a managed agent).
//
//   POST /api/admin/agents/:agentId/kill     — trip the switch (manager)
//   POST /api/admin/agents/:agentId/unkill   — clear the switch (manager)
//   GET  /api/admin/agents/kill-status       — the current killed set (manager)
//
// The MECHANISM already exists end-to-end: the per-agent AgentKillSwitchManager
// (claustrum/agent-kill-switch.ts) writes the Redis emergency-stop + broadcasts,
// the host-side killGuardedRunner suppresses a killed agent's trigger before it
// opens a capsule, and the kernel-side kill guard REFUSEs an in-flight turn.
// The ONLY missing piece was an operator-reachable control — this file adds it,
// reusing manager.trip()/clear() verbatim (NO new mechanism, NO new Redis key).
//
// Gate: `requireManagerRole` (MANAGER+). The emergency brake is a make-things-
// safer act and must be broadly reachable in an incident; it mirrors the sibling
// agent-control surface (admin/agent-approvals.ts resolve) and the ops-alert
// resolve, both MANAGER-gated. Registered UNDER adminRoutes, so it inherits the
// staff-JWT / admin-API-key guard + the onResponse audit hook; each mutation
// additionally emits a structured operator-action log (manager.trip does not
// itself log — the ENGAGED/cleared line only fires when the poller applies it).
//
// Plane opt-in: the manager only exists when IBX_AGENTS_ENABLED=true. When the
// plane is off the manager is null → 503 (the control is temporarily
// unavailable), never a 500. An unknown agentId (not in AGENT_REGISTRY) is a
// 404 and never trips a phantom switch.

import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AGENT_REGISTRY, type AgentDefinition } from "@ibatexas/agents";
import { getAgentKillSwitchManager } from "../../claustrum-bootstrap.js";
import type { AgentKillSwitchManager } from "../../claustrum/agent-kill-switch.js";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { logger } from "../../lib/logger.js";

const PLANE_OFF = {
  statusCode: 503,
  error: "Service Unavailable",
  message: "Plano de agentes indisponível (IBX_AGENTS_ENABLED).",
} as const;

const AgentIdParams = z.object({ agentId: z.string().min(1).max(256) });
const StatusQuery = z.object({ agentId: z.string().min(1).max(256).optional() });

const DEFAULT_TRIP_REASON = "parada manual via painel admin";

/**
 * The trip reason is an OPTIONAL ops annotation stored in the kill-switch state
 * (never customer-facing). Read it defensively off the raw body — the route
 * carries NO body schema so a bodyless POST is a valid trip (a Fastify JSON
 * body schema 400s an empty POST, and demanding a body for an emergency brake
 * is the wrong ergonomics). Bounded to 500 chars.
 */
function tripReasonOf(body: unknown): string {
  const raw = (body as { reason?: unknown } | undefined)?.reason;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.slice(0, 500);
  }
  return DEFAULT_TRIP_REASON;
}

/** Look an agent up in the real registry; unknown ids never trip a phantom. */
function findAgent(agentId: string): AgentDefinition | null {
  return AGENT_REGISTRY.find((a) => a.id === agentId) ?? null;
}

function unknownAgent(agentId: string) {
  return {
    statusCode: 404,
    error: "Not Found",
    message: `Agente desconhecido: "${agentId}".`,
  } as const;
}

/** Operator provenance for the action log (JWT staff, else the registry key role). */
function actorOf(request: {
  staffId?: string;
  adminApiKeyRole?: "OWNER" | "MANAGER";
}): string {
  return request.staffId
    ? `staff:${request.staffId}`
    : `admin-api-key:${request.adminApiKeyRole ?? "unknown"}`;
}

/**
 * Shared preamble for the two mutations: validate the id against the real
 * registry FIRST (unknown → 404, never reaching the manager, so no phantom
 * trip), then resolve the live manager (plane opt-in-off → 503). Returns the
 * manager, or null after having sent the terminal error response.
 */
function resolveManagerOrRespond(
  agentId: string,
  reply: FastifyReply,
): AgentKillSwitchManager | null {
  if (findAgent(agentId) === null) {
    void reply.code(404).send(unknownAgent(agentId));
    return null;
  }
  const manager = getAgentKillSwitchManager();
  if (manager === null) {
    void reply.code(503).send(PLANE_OFF);
    return null;
  }
  return manager;
}

export async function adminAgentKillSwitchRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── POST /api/admin/agents/:agentId/kill — trip the switch ───────────────────
  app.post(
    "/api/admin/agents/:agentId/kill",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Acionar o kill-switch de um agente (parada de emergência)",
        params: AgentIdParams,
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const manager = resolveManagerOrRespond(agentId, reply);
      if (manager === null) return reply;

      const reason = tripReasonOf(request.body);
      const actor = actorOf(request);
      // trip() writes Redis + broadcasts; re-tripping an already-killed agent is
      // idempotent (still killed) — the response is always { killed: true }.
      await manager.trip(agentId, reason);
      logger.warn(
        { component: "agent-kill-switch", action: "trip", agentId, actor, reason },
        "operador acionou o kill-switch de um agente",
      );
      return reply.send({ agentId, killed: true });
    },
  );

  // ── POST /api/admin/agents/:agentId/unkill — clear the switch ────────────────
  app.post(
    "/api/admin/agents/:agentId/unkill",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Liberar o kill-switch de um agente (restaurar operação)",
        params: AgentIdParams,
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const manager = resolveManagerOrRespond(agentId, reply);
      if (manager === null) return reply;

      const actor = actorOf(request);
      // clear() is idempotent — clearing an already-live agent stays live.
      await manager.clear(agentId);
      logger.warn(
        { component: "agent-kill-switch", action: "clear", agentId, actor },
        "operador liberou o kill-switch de um agente (operação restaurada)",
      );
      return reply.send({ agentId, killed: false });
    },
  );

  // ── GET /api/admin/agents/kill-status — the current killed set ───────────────
  //
  // Read-only. The manager exposes isKilled(namespace) keyed by the agent's
  // sessionIdPrefix (NOT its id), so map id → sessionIdPrefix per registry row.
  // No agentId → the full roster's status; ?agentId= → that one (404 if unknown).
  app.get(
    "/api/admin/agents/kill-status",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Estado do kill-switch dos agentes (conjunto de mortos)",
        querystring: StatusQuery,
      },
    },
    async (request, reply) => {
      const manager = getAgentKillSwitchManager();
      if (manager === null) return reply.code(503).send(PLANE_OFF);

      const { agentId } = request.query;
      if (agentId !== undefined) {
        const agent = findAgent(agentId);
        if (agent === null) return reply.code(404).send(unknownAgent(agentId));
        return reply.send({
          agents: [{ agentId: agent.id, killed: manager.isKilled(agent.sessionIdPrefix) }],
        });
      }
      const agents = AGENT_REGISTRY.map((a) => ({
        agentId: a.id,
        killed: manager.isKilled(a.sessionIdPrefix),
      }));
      return reply.send({ agents });
    },
  );
}
