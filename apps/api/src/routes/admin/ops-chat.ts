// admin/ops-chat.ts — the ops-actor ingress (NEW-032 slice B): the staff
// "run the restaurant by message" channel goes live.
//
//   POST /api/admin/ops/chat  { message }  → { reply, decision, executed, proposedKinds }
//
// Behind `requireStaff` (JWT-only — no API-key conversational actor). The route
// captures {staffId, staffRole} from the JWT, composes the OPS conductor for the
// turn (getOpsConductorFactory — the H1 per-request recomposition), opens a
// "system"-channel capsule whose actor is `admin:${staffId}` + role, runs one
// kernel-gated turn, and returns the reply synchronously (no SSE in v1).
//
// Layered role enforcement (defense in depth): route preHandler
// (authentication) → capability planner (advertisement, staff-gated) →
// staffRoleGuard + the staff-role matrix (kernel authorization) → per-kind pack
// guards. A conductor throw returns an honest 502 with a pt-BR message — never a
// fabricated success.
//
// v1 posture: STATELESS turns (the claustrum SessionPort save/load are stubs, no
// history persists — a follow-up wires ops history); a REQUEST_CONFIRMATION
// surfaces the kernel prompt honestly and resolution is out-of-band (no
// conversational confirm-resume on this channel yet — a registered follow-up).

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { handleTurn, type ChannelMessage } from "@claustrum/core";
import { requireStaff } from "../../middleware/staff-auth.js";
import { getOpsConductorFactory } from "../../claustrum-bootstrap.js";

const OpsChatBody = z.object({
  message: z
    .string({ error: "Informe uma mensagem." })
    .trim()
    .min(1, "A mensagem não pode estar vazia.")
    .max(2000, "A mensagem é muito longa (máximo 2000 caracteres)."),
});

/** Was a mutation actually committed this turn? (dispatch matrix — handleTurn). */
function wasExecuted(acted: { kind?: string } | undefined): boolean {
  const kind = acted?.kind;
  return (
    kind === "executed" ||
    kind === "rewritten_and_executed" ||
    kind === "executed_plan"
  );
}

export async function adminOpsChatRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/admin/ops/chat",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Canal operacional do agente (comandar por mensagem)",
        body: OpsChatBody,
      },
    },
    async (request, reply) => {
      // requireStaff guarantees both are set (JWT-only); narrow for TS + a
      // belt-and-suspenders fail-closed if the guard is ever bypassed.
      const staffId = request.staffId;
      const staffRole = request.staffRole;
      if (!staffId || !staffRole) {
        return reply.code(403).send({ error: "Acesso restrito a funcionários." });
      }

      const { message } = request.body;
      const conversationId = `admin:${staffId}`;
      const inbound: ChannelMessage = {
        channel: "system",
        customerId: `staff:${staffId}`,
        conversationId,
        externalId: randomUUID(),
        text: message,
        receivedAt: new Date().toISOString(),
        locale: "pt-BR",
      };

      // Compose the per-request ops conductor with the AUTHENTICATED identity
      // (never model-derived). A missing factory (bootstrap not run) throws — a
      // 500-class server error, surfaced honestly below.
      let conductor;
      try {
        conductor = getOpsConductorFactory()({ staffId, role: staffRole });
      } catch (err) {
        request.log.error(err, "[ops-chat] ops conductor factory unavailable");
        return reply.code(503).send({
          error: "Canal operacional indisponível no momento.",
        });
      }

      const capsule = await conductor.openCapsule({
        channel: "system",
        customerId: `staff:${staffId}`,
        // The entity-scoped serialization domain (the conductor's default lock
        // key ignores sessionKey; it still feeds actor.sessionId / TenantResolver).
        sessionKey: `ops:${staffId}`,
        actor: {
          principal: "user",
          role: "staff",
          sessionId: conversationId,
          staffId,
        },
        inbound,
      });

      try {
        const turn = await handleTurn(capsule, inbound);
        return reply.send({
          reply: turn.response.text,
          decision: turn.decision.kind,
          executed: wasExecuted(turn.acted),
          proposedKinds: turn.plan.envelopes.map((e) => String(e.kind)),
        });
      } catch (err) {
        // Never fabricate success: an honest 502 with a pt-BR message.
        request.log.error(err, "[ops-chat] ops conductor turn failed");
        return reply.code(502).send({
          error: "Não consegui processar seu comando agora. Tente novamente.",
        });
      } finally {
        await conductor.closeCapsule(capsule);
      }
    },
  );
}
