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
import { createConversationService, prisma } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";

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

  const mapSummary = (c: {
    id: string;
    sessionId: string;
    customerId: string | null;
    channel: string;
    messageCount: number;
    lastMessageAt: Date | null;
  }) => ({
    id: c.id,
    sessionId: c.sessionId,
    customerId: c.customerId,
    channel: c.channel,
    messageCount: c.messageCount,
    lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
  });

  const parseDate = (s?: string): Date | undefined => {
    if (!s) return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };

  app.get(
    "/api/admin/conversations",
    {
      // WS4B — Conversas exposes un-redacted customer PII; owner decision: gate
      // it (and the order-id lookup) to MANAGER/OWNER, not any staff.
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Listar/buscar conversas (admin)",
        querystring: z.object({
          sessionId: z.string().min(1).max(256).optional(),
          customerId: z.string().min(1).max(256).optional(),
          phone: z.string().min(1).max(40).optional(),
          /** WS4B — human order displayId; resolved INDIRECTLY to the customer. */
          orderId: z.string().min(1).max(40).optional(),
          date_from: z.string().optional(),
          date_to: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional().default(20),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
        response: {
          200: z.object({
            conversations: z.array(ConversationSummarySchema),
            count: z.number().int(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { sessionId, customerId, phone, orderId, date_from, date_to, limit, offset } =
        request.query;

      // sessionId is a UNIQUE exact lookup — date/offset are meaningless for it, so
      // it keeps the direct fast-path. Every other mode (customerId / phone /
      // orderId / default) routes through listForAdmin below so the date window +
      // offset pagination the UI always sends are honored consistently. (S4: the
      // phone branch previously dropped both filters silently.)
      if (sessionId) {
        const rows = await svc().searchConversations({ sessionId, limit });
        return reply.send({ conversations: rows.map(mapSummary), count: rows.length });
      }

      // Order-id search = INDIRECT via customer: resolve the human displayId to
      // its customer, then list that customer's conversations. An unknown / non-
      // numeric order id → empty (never all, never 500) — the honest degrade.
      let effectiveCustomerId = customerId;
      if (orderId) {
        const displayId = Number(orderId);
        if (!Number.isInteger(displayId)) {
          return reply.send({ conversations: [], count: 0 });
        }
        const order = await prisma.orderProjection.findFirst({
          where: { displayId },
          select: { customerId: true },
        });
        if (!order?.customerId) {
          return reply.send({ conversations: [], count: 0 });
        }
        effectiveCustomerId = order.customerId;
      }

      const { rows, count } = await svc().listForAdmin({
        ...(effectiveCustomerId ? { customerId: effectiveCustomerId } : {}),
        ...(phone ? { phone } : {}),
        ...(parseDate(date_from) ? { dateFrom: parseDate(date_from) } : {}),
        ...(parseDate(date_to) ? { dateTo: parseDate(date_to) } : {}),
        limit,
        offset,
      });
      return reply.send({ conversations: rows.map(mapSummary), count });
    },
  );

  app.get(
    "/api/admin/conversations/:sessionId",
    {
      preHandler: [requireManagerRole],
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
