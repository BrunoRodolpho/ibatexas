// Admin incidents — full manager-gated REST inbox (W1 Phase 3a, REST only).
//
// The no-reply incident journal surfaced to staff. ALL routes carry
// `preHandler:[requireManagerRole]` (staff-auth.ts, fail-closes 403) — the list
// and detail expose `customerId` + the transcript, and reply/resolve act on a
// customer's behalf, so every route is manager-gated on top of the parent
// adminRoutes DOM-001 guard.
//
//   GET  /api/admin/incidents          open + history, filtered, pre-sorted;
//                                       returns the INDEPENDENT openCount badge
//   GET  /api/admin/incidents/:id       incident + reused transcript
//   POST /api/admin/incidents/:id/resolve   governed STAFF close (Resolver)
//   POST /api/admin/incidents/:id/reply     staff take-over reply + auto-close
//
// Severity is derived authoritatively server-side (read-time, the service's pure
// `deriveSeverity`) and the list is PRE-SORTED by composite key here because the
// admin DataTable can only single-column click-sort.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createIncidentService,
  createConversationService,
  prisma,
  type ConversationIncident,
  type IncidentClosePayload,
  type IncidentSeverity,
  type IncidentStatus,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { getWhatsAppSender } from "@ibatexas/tools";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { buildSystemEnvelope } from "../../subscribers/__shared__/system-actor-envelope.js";
import { closeIncidentOnDeliveredReply } from "../../incidents/incident-auto-close.js";

// Re-declared module-local (the canonical copy is module-local at
// conversations.ts:26 — not exported, so the detail route re-declares it).
const TranscriptMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  sentAt: z.string(),
  metadata: z.unknown(),
});

const STATUS_VALUES = [
  "OPEN",
  "ACKNOWLEDGED",
  "AUTO_RESOLVED",
  "RESOLVED",
] as const satisfies readonly IncidentStatus[];

const CAUSE_VALUES = [
  "empty_completion",
  "whitespace_only",
  "send_failed",
  "retry_exhausted",
  "timeout",
] as const;

const SEVERITY_VALUES = ["low", "medium", "high"] as const satisfies readonly IncidentSeverity[];

const ListQuery = z.object({
  status: z.enum(STATUS_VALUES).optional(),
  cause: z.enum(CAUSE_VALUES).optional(),
  severity: z.enum(SEVERITY_VALUES).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  agingMinutes: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Default sort (computed server-side — DataTable can't multi-key) ───────────
// status-bucket (OPEN/ACK active first) → age (aged-first / oldest first) →
// severity desc (high first). The row most likely to need a human floats up.

const SEVERITY_RANK: Record<IncidentSeverity, number> = { high: 0, medium: 1, low: 2 };

function statusBucket(status: IncidentStatus): number {
  return status === "OPEN" || status === "ACKNOWLEDGED" ? 0 : 1;
}

function defaultIncidentSort(
  a: ConversationIncident,
  b: ConversationIncident,
): number {
  const bucket = statusBucket(a.status) - statusBucket(b.status);
  if (bucket !== 0) return bucket;
  const age = a.openedAt.getTime() - b.openedAt.getTime(); // oldest (aged) first
  if (age !== 0) return age;
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]; // high first
}

// ── Discriminable resolve conflict (P1-2 §4) ──────────────────────────────────
// So the UI never blames a human for the bot's self-heal. Computed from the
// AUTHORITATIVE post-close row: if WE were the closer the resolve succeeded;
// otherwise classify who beat us (bot auto-heal vs another staff/handoff vs a
// non-terminal anomaly).
type ResolveConflict = "auto_resolved" | "changed_by_other" | "invalid_transition";

function resolveConflict(
  row: ConversationIncident,
  expectedResolvedBy: string,
): ResolveConflict | null {
  if (row.resolutionType === "STAFF" && row.resolvedBy === expectedResolvedBy) {
    return null; // we won the transition
  }
  if (row.resolutionType === "AUTO") return "auto_resolved";
  if (row.resolutionType === "STAFF" || row.resolutionType === "HANDED_OFF") {
    return "changed_by_other";
  }
  return "invalid_transition";
}

export async function adminIncidentRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting
  // the admin plugin with a partial `@ibatexas/domain` mock doesn't trip over a
  // missing factory at register time (mirrors conversations.ts).
  let incidentSvc: ReturnType<typeof createIncidentService> | undefined;
  const svc = () => (incidentSvc ??= createIncidentService({ auditSink: getAuditSink() }));
  let conversationSvc: ReturnType<typeof createConversationService> | undefined;
  const convoSvc = () => (conversationSvc ??= createConversationService());

  // ── GET /api/admin/incidents — list (open + history) + independent badge ────
  app.get(
    "/api/admin/incidents",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Incidentes de não-resposta (lista + contagem de abertos)",
        querystring: ListQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof ListQuery>;
      const { rows, openCount } = await svc().list({
        ...(q.status ? { status: q.status } : {}),
        ...(q.cause ? { cause: q.cause } : {}),
        ...(q.severity ? { severity: q.severity } : {}),
        ...(q.sessionId ? { sessionId: q.sessionId } : {}),
        ...(q.agingMinutes !== undefined ? { agingMinutes: q.agingMinutes } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      });
      // Pre-sort here (severity already refreshed read-time by the service).
      // openCount is the INDEPENDENT COUNT(status=OPEN), never rows.length.
      const incidents = [...rows].sort(defaultIncidentSort);
      return reply.send({ incidents, openCount });
    },
  );

  // ── GET /api/admin/incidents/:id — incident + reused transcript ─────────────
  app.get(
    "/api/admin/incidents/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Detalhe de um incidente (com transcrição)",
        params: z.object({ id: z.string().min(1).max(256) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const incident = await svc().get(id);
      if (!incident) {
        return reply.code(404).send({ error: "incident_not_found" });
      }

      // Reuse the conversation transcript (conversation.service findBySessionId
      // + getTranscript). The Conversation row may not exist yet (guest /
      // not-yet-archived) → empty transcript, never a 404.
      const convo =
        incident.conversationId != null
          ? { id: incident.conversationId }
          : await convoSvc().findBySessionId(incident.sessionId);
      const messages = convo
        ? z.array(TranscriptMessageSchema).parse(
            (await convoSvc().getTranscript(convo.id)).map((m) => ({
              role: m.role,
              content: m.content,
              sentAt: m.sentAt.toISOString(),
              metadata: m.metadata,
            })),
          )
        : [];

      return reply.send({ incident, messages });
    },
  );

  // ── POST /api/admin/incidents/:id/resolve — governed STAFF close ────────────
  app.post(
    "/api/admin/incidents/:id/resolve",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Resolver um incidente (Resolver — fechamento manual)",
        params: z.object({ id: z.string().min(1).max(256) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const staffId = request.staffId ?? null;
      const resolvedBy = staffId ? `staff:${staffId}` : "admin-key";

      const payload: IncidentClosePayload = {
        id,
        resolvedBy,
        resolutionType: "STAFF",
        closingTurnId: null,
      };
      const envelope = buildSystemEnvelope({
        kind: "incident.ticket.close" as const,
        payload,
        sourceSubject: "incident.staff_resolve",
        eventId: `${id}:resolve:${Date.now()}`,
      });
      const out = await svc().closeIncidentFromEnvelope(envelope, {});
      const row = out.result ?? null;

      // 404 ONLY when the id does not exist (closeExecutor returns null). An
      // already-RESOLVED / AUTO_RESOLVED row returns the current row → 200 with a
      // discriminable conflict reason (avoids the second-click / race 404).
      if (!row) {
        return reply.code(404).send({ error: "incident_not_found" });
      }
      const conflict = resolveConflict(row, resolvedBy);
      return reply.send({ incident: row, conflict });
    },
  );

  // ── POST /api/admin/incidents/:id/reply — staff take-over + auto-close ──────
  app.post(
    "/api/admin/incidents/:id/reply",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Responder a um incidente (take-over humano)",
        params: z.object({ id: z.string().min(1).max(256) }),
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
      const { id } = request.params;
      const { text } = request.body;
      const incident = await svc().get(id);
      if (!incident) {
        return reply.code(404).send({ error: "incident_not_found" });
      }

      const staffId = request.staffId ?? null;
      const channel = incident.channel;

      // Record the staff reply in the durable transcript (assistant-side),
      // tagged via:staff_takeover (+incidentId). Best-effort: the Conversation
      // row may not exist yet (guest / not-yet-archived) → skip the append but
      // still deliver via senderRef.
      const convo =
        incident.conversationId != null
          ? { id: incident.conversationId }
          : await convoSvc().findBySessionId(incident.sessionId);
      if (convo) {
        await convoSvc().appendMessage({
          conversationId: convo.id,
          role: "assistant",
          content: text,
          metadata: {
            via: "staff_takeover",
            incidentId: id,
            ...(staffId ? { staffId } : {}),
          },
        });
      }

      // Phone resolution (P1-5): customerId → customer.phone; FALL BACK to the
      // incident's senderRef when customerId is null (guest / not-yet-archived),
      // where escalations.ts returns null and the reply is undeliverable.
      // senderRef is already channel-addressable (`whatsapp:<phone>`); the
      // customer path needs the prefix added.
      let to: string | null = null;
      if (incident.customerId) {
        const customer = await prisma.customer.findUnique({
          where: { id: incident.customerId },
          select: { phone: true },
        });
        if (customer?.phone) to = `whatsapp:${customer.phone}`;
      }
      if (!to && incident.senderRef) to = incident.senderRef;

      let delivered = false;
      if (channel === "whatsapp" && to) {
        try {
          const sender = getWhatsAppSender();
          if (sender) {
            await sender.sendText(to, text);
            delivered = true;
          }
        } catch (err) {
          request.log.error(
            { incidentId: id, error: String(err) },
            "[incidents] WhatsApp delivery of staff reply failed (recorded in transcript regardless)",
          );
        }
      }

      // P1-3: a delivered staff take-over reply IS a delivered assistant reply —
      // and is the ONLY thing that can close an incident on a session paused for
      // human handoff. Fail-open; deliberately does NOT touch bot-pause state.
      if (delivered) {
        await closeIncidentOnDeliveredReply(
          incident.sessionId,
          `staff_takeover:${staffId ?? "admin-key"}:${Date.now()}`,
          {
            info: (...a) => request.log.info(a[0] as object, a[1] as string),
            warn: (...a) => request.log.warn(a[0] as object, a[1] as string),
            error: (...a) => request.log.error(a[0] as object, a[1] as string),
          },
        );
      }

      return reply.send({ ok: true, delivered, channel });
    },
  );
}
