// Admin conversation history + search + correlate (responder-trace-admin D1).
//
// PII-bearing, staff-authed: this is the ONE intentionally un-redacted surface
// (the plan) — support staff read a customer's real transcript. Auth is the
// DOM-001 admin guard applied by the parent `adminRoutes` plugin (staff JWT
// cookie OR x-admin-key). Read-only; no kernel mutation.
//
//   GET /api/admin/conversations            list/search by sessionId|customerId|phone
//   GET /api/admin/conversations/:sessionId  transcript + the customerId for the
//                                            orders cross-link (the conversas page)

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createConversationService } from "@ibatexas/domain";

const ConversationSummarySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  customerId: z.string().nullable(),
  channel: z.string(),
  messageCount: z.number().int(),
  lastMessageAt: z.string().nullable(),
});

// The canonical rendered-transcript message shape. Exported as the single source
// of truth so the incidents detail route reuses it instead of re-declaring it.
export const TranscriptMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  sentAt: z.string(),
  metadata: z.unknown(),
});

export async function conversationRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  // Lazily construct on first request, NOT at registration time — so a test
  // that mounts the admin plugin with a partial `@ibatexas/domain` mock (e.g.
  // admin-reviews) doesn't trip over a missing createConversationService at
  // register time. Read-only methods need no auditSink (those are the
  // envelope-typed writers).
  let cached: ReturnType<typeof createConversationService> | undefined;
  const svc = () => (cached ??= createConversationService());

  app.get(
    "/api/admin/conversations",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar/buscar conversas (admin)",
        querystring: z.object({
          sessionId: z.string().min(1).max(256).optional(),
          customerId: z.string().min(1).max(256).optional(),
          phone: z.string().min(1).max(40).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional().default(50),
        }),
        response: {
          200: z.object({ conversations: z.array(ConversationSummarySchema) }),
        },
      },
    },
    async (request, reply) => {
      const { sessionId, customerId, phone, limit } = request.query;
      const rows = await svc().searchConversations({
        ...(sessionId ? { sessionId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(phone ? { phone } : {}),
        limit,
      });
      return reply.send({
        conversations: rows.map((c) => ({
          id: c.id,
          sessionId: c.sessionId,
          customerId: c.customerId,
          channel: c.channel,
          messageCount: c.messageCount,
          lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
        })),
      });
    },
  );

  app.get(
    "/api/admin/conversations/:sessionId",
    {
      schema: {
        tags: ["admin"],
        summary: "Transcrição de uma conversa (admin)",
        params: z.object({ sessionId: z.string().min(1).max(256) }),
        response: {
          200: z.object({
            sessionId: z.string(),
            customerId: z.string().nullable(),
            channel: z.string().nullable(),
            messages: z.array(TranscriptMessageSchema),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      const convo = await svc().findBySessionId(sessionId);
      if (!convo) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
      const [messages, summaries] = await Promise.all([
        svc().getTranscript(convo.id),
        svc().searchConversations({ sessionId }),
      ]);
      const summary = summaries[0];
      return reply.send({
        sessionId,
        customerId: summary?.customerId ?? null,
        channel: summary?.channel ?? null,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          sentAt: m.sentAt.toISOString(),
          metadata: m.metadata ?? null,
        })),
      });
    },
  );
}
