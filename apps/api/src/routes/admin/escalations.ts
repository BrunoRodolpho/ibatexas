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
import { getWhatsAppSender } from "@ibatexas/tools";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { getEscalationStore } from "../../escalation/escalation-store.js";

const EscalationRecordSchema = z.object({
  sessionId: z.string(),
  customerId: z.string().nullable(),
  reason: z.string().nullable(),
  channel: z.string().nullable(),
  handoffAt: z.string(),
  status: z.enum(["open", "resolved"]),
  resolvedAt: z.string().optional(),
  resolvedBy: z.string().optional(),
});

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
      return reply.send({ escalations });
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
      // Record the staff reply in the durable transcript (assistant-side).
      await svc().appendMessage({
        conversationId: convo.id,
        role: "assistant",
        content: text,
        metadata: {
          via: "staff_takeover",
          ...(staffId ? { staffId } : {}),
        },
      });

      // Deliver on the channel. WhatsApp delivers live; web is recorded-only
      // (the customer's live SSE push from a separate route is a follow-up).
      let delivered = false;
      const summary = (await svc().searchConversations({ sessionId }))[0];
      const channel = summary?.channel ?? null;
      if (channel === "whatsapp" && summary?.customerId) {
        try {
          const customer = await prisma.customer.findUnique({
            where: { id: summary.customerId },
            select: { phone: true },
          });
          const sender = getWhatsAppSender();
          if (customer?.phone && sender) {
            await sender.sendText(`whatsapp:${customer.phone}`, text);
            delivered = true;
          }
        } catch (err) {
          request.log.error(
            { sessionId, error: String(err) },
            "[escalations] WhatsApp delivery of staff reply failed (recorded in transcript regardless)",
          );
        }
      }

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
      return reply.send({ ok: true, resolved });
    },
  );
}
