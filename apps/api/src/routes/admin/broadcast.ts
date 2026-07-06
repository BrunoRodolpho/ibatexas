// Admin broadcast / blast (responder-trace-admin D3).
//
// Manager-gated (requireManagerRole) proactive WhatsApp send to a recipient
// segment, with a pre-approved template. Sends SEQUENTIALLY through the existing
// rate-limited + idempotent WhatsApp client, honors the opt-out registry, and
// returns per-recipient status + aggregate counts.
//
//   POST /api/admin/broadcast                 { recipients[], template } → counts
//   GET  /api/admin/broadcast/optout          list opted-out recipients
//   POST /api/admin/broadcast/optout          { recipient } → opt a number out
//   POST /api/admin/broadcast/optin           { recipient } → re-subscribe

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { mintBroadcastReply } from "@adjudicate/core";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { sendText } from "../../whatsapp/client.js";
import { runBroadcast } from "../../broadcast/broadcast.js";
import { getBroadcastOptOutStore, normalizeRecipient } from "../../broadcast/broadcast-optout.js";
import { prisma, Prisma } from "@ibatexas/domain";

const RecipientResultSchema = z.object({
  recipient: z.string(),
  status: z.enum(["sent", "skipped_opted_out", "failed"]),
  error: z.string().optional(),
});

export async function broadcastRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/admin/broadcast",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Disparo em massa (WhatsApp) — gerente",
        body: z.object({
          recipients: z.array(z.string().min(1).max(40)).min(1).max(5000),
          template: z.string().min(1).max(4096),
        }),
        response: {
          200: z.object({
            total: z.number().int(),
            sent: z.number().int(),
            skipped: z.number().int(),
            failed: z.number().int(),
            results: z.array(RecipientResultSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const { recipients, template } = request.body;
      const optOut = await getBroadcastOptOutStore();
      // WS3B — canonicalize BEFORE runBroadcast so its dedup collapses
      // format-variants of the same number (no double-send), the opt-out check
      // matches the (also-normalized) registry, and the actual WhatsApp send
      // targets a canonical E.164 number.
      const normalized = recipients.map(normalizeRecipient);
      const result = await runBroadcast({
        recipients: normalized,
        template,
        // The client adds the `whatsapp:` channel prefix expectations; mirror the
        // handoff-subscriber call shape. The client itself rate-limits + dedups.
        send: (recipient, body) => sendText(`whatsapp:${recipient}`, mintBroadcastReply(body)),
        isOptedOut: (recipient) => optOut.isOptedOut(recipient),
      });
      // WS3C — persist a durable audit of the blast (compliance: prove what was
      // sent to whom, by whom, when). Best-effort: the sends already happened, so
      // an audit-write failure is logged but never fails the response.
      try {
        await prisma.broadcastSend.create({
          data: {
            senderStaffId: request.staffId ?? null,
            template,
            totalCount: result.total,
            sentCount: result.sent,
            skippedCount: result.skipped,
            failedCount: result.failed,
            results: result.results as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        request.log.error(
          { component: "broadcast", err },
          "[broadcast] audit persist failed (blast already sent)",
        );
      }
      request.log.info(
        {
          component: "broadcast",
          total: result.total,
          sent: result.sent,
          skipped: result.skipped,
          failed: result.failed,
        },
        "[broadcast] blast complete",
      );
      return reply.send(result);
    },
  );

  app.get(
    "/api/admin/broadcast/optout",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Listar destinatários que optaram por não receber",
        response: { 200: z.object({ recipients: z.array(z.string()) }) },
      },
    },
    async (_request, reply) => {
      const optOut = await getBroadcastOptOutStore();
      return reply.send({ recipients: await optOut.list() });
    },
  );

  app.post(
    "/api/admin/broadcast/optout",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Registrar opt-out de um destinatário",
        body: z.object({ recipient: z.string().min(1).max(40) }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const optOut = await getBroadcastOptOutStore();
      await optOut.optOut(request.body.recipient);
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/admin/broadcast/optin",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Reativar (opt-in) um destinatário",
        body: z.object({ recipient: z.string().min(1).max(40) }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const optOut = await getBroadcastOptOutStore();
      await optOut.optIn(request.body.recipient);
      return reply.send({ ok: true });
    },
  );
}
