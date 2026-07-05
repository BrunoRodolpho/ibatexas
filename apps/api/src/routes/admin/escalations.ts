// Admin escalation queue + take-over reply/resolve (responder-trace-admin D2).
//
// Manager-gated (requireManagerRole) on top of the parent adminRoutes DOM-001
// guard. The parent guard only proves the caller is *some* authenticated staff
// (any role, incl. ATTENDANT) or holds *any* valid x-admin-key — including a
// key with no role mapping. Take-over reply/resolve deliver arbitrary text to a
// customer over WhatsApp AS the business and un-pause the bot, so they MUST fail
// closed for non-manager principals (mirrors D3 broadcast). The read-only queue
// is gated too: it exposes the open-escalation list (customerId/reason/channel).
//   GET  /api/admin/escalations                  the open take-over queue
//   POST /api/admin/escalations/:sessionId/reply  append a staff reply to the
//        transcript + deliver it on the channel (WhatsApp live; web = recorded)
//   POST /api/admin/escalations/:sessionId/resolve  resolve → un-pauses the bot
//
// The reply is recorded as an `assistant` message tagged via:staff_takeover, so
// it shows in the transcript regardless of channel; WhatsApp additionally
// delivers live to the customer. Resolving clears the bot-pause so the LLM
// resumes auto-replying.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createConversationService, prisma } from "@ibatexas/domain";
import {
  requireManagerRole,
  requireOwnerRole,
} from "../../middleware/staff-auth.js";
import { getEscalationStore } from "../../escalation/escalation-store.js";
import { getEscalationApprovalGateway } from "../../claustrum-bootstrap.js";
import { toLogFn } from "../../utils/to-log-fn.js";
import { staffTakeoverReply } from "./_shared-staff-reply.js";

// AUT-017 — the parked-money-intent projection carried on an escalation record.
const PendingIntentSchema = z.object({
  token: z.string(),
  intentKind: z.string(),
  intentHash: z.string(),
  summaryPtBr: z.string(),
  requestedAt: z.string(),
  status: z.enum(["pending", "approved", "rejected", "denied_by_kernel", "expired"]),
  resolvedAt: z.string().optional(),
  resolvedBy: z.string().optional(),
});

const EscalationRecordSchema = z.object({
  sessionId: z.string(),
  customerId: z.string().nullable(),
  reason: z.string().nullable(),
  channel: z.string().nullable(),
  handoffAt: z.string(),
  status: z.enum(["open", "resolved"]),
  resolvedAt: z.string().optional(),
  resolvedBy: z.string().optional(),
  // AUT-017 — parked money intents awaiting OWNER approval (optional/additive).
  pendingIntents: z.array(PendingIntentSchema).optional(),
});

/** The store returns `readonly` arrays; the zod-inferred reply type is mutable —
 *  cast at the serialization boundary (Fastify re-validates against the schema). */
type EscalationRecordDto = z.infer<typeof EscalationRecordSchema>;

export async function escalationRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  let cached: ReturnType<typeof createConversationService> | undefined;
  const svc = () => (cached ??= createConversationService());

  app.get(
    "/api/admin/escalations",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Fila de escalações abertas (take-over)",
        response: {
          200: z.object({ escalations: z.array(EscalationRecordSchema) }),
        },
      },
    },
    async (_request, reply) => {
      const store = await getEscalationStore();
      const escalations = await store.listOpen(100);
      return reply.send({
        escalations: escalations as unknown as EscalationRecordDto[],
      });
    },
  );

  app.post(
    "/api/admin/escalations/:sessionId/reply",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Responder a uma conversa em take-over (humano)",
        params: z.object({ sessionId: z.string().min(1).max(256) }),
        body: z.object({ text: z.string().min(1).max(4096) }),
        response: {
          200: z.object({
            ok: z.boolean(),
            delivered: z.boolean(),
            channel: z.string().nullable(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      const { text } = request.body;
      const convo = await svc().findBySessionId(sessionId);
      if (!convo) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }

      const staffId = request.staffId ?? null;

      // Resolve the recipient + channel (WhatsApp delivers live; other channels
      // are recorded-only). Phone lives on the customer row, keyed by the summary.
      const summary = (await svc().searchConversations({ sessionId }))[0];
      const channel = summary?.channel ?? null;
      let to: string | null = null;
      if (channel === "whatsapp" && summary?.customerId) {
        const customer = await prisma.customer.findUnique({
          where: { id: summary.customerId },
          select: { phone: true },
        });
        if (customer?.phone) to = `whatsapp:${customer.phone}`;
      }

      // Shared: record the reply + deliver + (on delivery) close the incident as
      // STAFF (P1-3). See ./_shared-staff-reply.ts.
      const delivered = await staffTakeoverReply({
        service: svc(),
        sessionId,
        text,
        channel,
        to,
        staffId,
        conversation: convo,
        logLabel: "escalations",
        log: toLogFn(request),
      });

      return reply.send({ ok: true, delivered, channel });
    },
  );

  app.post(
    "/api/admin/escalations/:sessionId/resolve",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Resolver uma escalação (reativa o atendimento automático)",
        params: z.object({ sessionId: z.string().min(1).max(256) }),
        response: {
          200: z.object({
            ok: z.boolean(),
            resolved: EscalationRecordSchema.nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      const staffId = request.staffId ?? null;
      const store = await getEscalationStore();
      const resolved = await store.resolve(
        sessionId,
        staffId ? `staff:${staffId}` : "admin-key",
        new Date().toISOString(),
      );
      return reply.send({
        ok: true,
        resolved: resolved as unknown as EscalationRecordDto | null,
      });
    },
  );

  // AUT-017 — OWNER approve/reject a parked, escalated money intent. `requireOwnerRole`
  // gates WHO may resume (separation-of-duty seam 2); the gateway re-adjudicates the
  // VERBATIM parked envelope through the audited kernel (seam 1) and, on EXECUTE,
  // runs the BKL-085 refund trio with the APPROVER as author. A self-approval → 409;
  // an expired/used park → 404; a since-parked terminal/partial state → 200
  // denied_by_kernel (kernel REFUSE, nothing executed); an executor throw after the
  // audited EXECUTE → 502 (honest failure, never fabricated success).
  app.post(
    "/api/admin/escalations/:sessionId/intents/:token/resolve",
    {
      preHandler: [requireOwnerRole],
      schema: {
        tags: ["admin"],
        summary: "Aprovar/recusar uma ação escalada pendente (OWNER)",
        params: z.object({
          sessionId: z.string().min(1).max(256),
          token: z.string().min(1).max(128),
        }),
        body: z.object({ accept: z.boolean() }),
        response: {
          200: z.object({
            ok: z.boolean(),
            status: z.enum(["approved", "rejected", "denied_by_kernel"]),
            decision: z.object({ kind: z.string() }).optional(),
            refusalPtBr: z.string().optional(),
          }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
          502: z.object({ ok: z.boolean(), status: z.string(), refusalPtBr: z.string() }),
          503: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      const { accept } = request.body;
      const gateway = getEscalationApprovalGateway();
      if (gateway === null) {
        // Only before bootstrapClaustrum() has wired it — should not happen in prod.
        return reply
          .code(503)
          .send({ error: "aprovações de escalação indisponíveis no momento" });
      }
      // requireOwnerRole guarantees OWNER (JWT staffRole or API-key adminApiKeyRole).
      const approver = {
        id: request.staffId ?? "admin-key",
        role: request.staffRole ?? request.adminApiKeyRole ?? "OWNER",
      };
      const result = await gateway.resolve({ token, accept, approver });
      switch (result.status) {
        case "missing":
          return reply
            .code(404)
            .send({ error: "aprovação expirada ou já utilizada" });
        case "self_approve":
          return reply
            .code(409)
            .send({ error: "aprovador não pode ser o autor da solicitação" });
        case "execute_failed":
          return reply.code(502).send({
            ok: false,
            status: result.status,
            refusalPtBr:
              result.refusalPtBr ??
              "A aprovação foi autorizada, mas a execução falhou.",
          });
        case "rejected":
        case "approved":
        case "denied_by_kernel":
          return reply.send({
            ok: true,
            status: result.status,
            ...(result.decision ? { decision: { kind: result.decision.kind } } : {}),
            ...(result.refusalPtBr ? { refusalPtBr: result.refusalPtBr } : {}),
          });
      }
    },
  );
}
