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

import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { mintBroadcastReply } from "@adjudicate/core";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { sendText } from "../../whatsapp/client.js";
import { runBroadcast } from "../../broadcast/broadcast.js";
import { getBroadcastOptOutStore, normalizeRecipient } from "../../broadcast/broadcast-optout.js";
import { prisma, Prisma, toE164BR } from "@ibatexas/domain";

const RecipientResultSchema = z.object({
  recipient: z.string(),
  status: z.enum(["sent", "skipped_opted_out", "failed"]),
  error: z.string().optional(),
});

export async function broadcastRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // S2 — reject an opt-out/opt-in recipient that does not canonicalize to E.164.
  // `normalizeRecipient` falls back to the raw string on a non-E.164 input, so a
  // manager typing a BR-local format (`5511999990000`, `011 99999-0000`) would
  // otherwise store an UN-MATCHABLE consent key while we returned `{ok:true}`: the
  // send-time gate normalizes recipients to `+55…` and would never match the raw
  // key, so the "opted-out" customer keeps getting blasts (LGPD exposure). Fail
  // the request with a clear message instead of recording an ineffective opt-out.
  const canonicalizeOrReject = (recipient: string, reply: FastifyReply): string | null => {
    try {
      return toE164BR(recipient);
    } catch {
      void reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Telefone inválido. Use o formato internacional, ex.: +55 11 99999-0000.",
      });
      return null;
    }
  };

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
        // S6/S10 — the sends already happened, so we never fail the response
        // (a client retry could re-blast). Log the AGGREGATE counts (not the
        // per-recipient `result.results` ledger, which holds up to 5000 RAW
        // phones — that raw ledger is the durable DB write's job, and a log copy
        // would be an erasure-resistant PII store violating the hash-only rule).
        request.log.error(
          {
            component: "broadcast",
            err,
            senderStaffId: request.staffId ?? null,
            template,
            total: result.total,
            sent: result.sent,
            skipped: result.skipped,
            failed: result.failed,
          },
          "[broadcast] audit persist failed (blast already sent) — counts logged; per-recipient ledger omitted (PII)",
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
      const canonical = canonicalizeOrReject(request.body.recipient, reply);
      if (canonical === null) return reply;
      const optOut = await getBroadcastOptOutStore();
      await optOut.optOut(canonical);
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
      const canonical = canonicalizeOrReject(request.body.recipient, reply);
      if (canonical === null) return reply;
      const optOut = await getBroadcastOptOutStore();
      await optOut.optIn(canonical);
      return reply.send({ ok: true });
    },
  );

  // ── POST /api/admin/broadcast/audience/preview — resolve a segment (WS3D) ────
  // A CONSTRAINED, whitelisted audience spec (never free SQL — Rule 9: the LLM,
  // if it builds this spec from natural language, has zero data authority; it
  // only fills these named fields, which compile to a parameterized Prisma query).
  // Returns the opted-out-filtered recipient phones + a sample, so the manager
  // reviews the count before sending. "Ordered in a range" and "created in a
  // range" both resolve to canonical E.164 phones the blast endpoint accepts.
  // S7 — the bare regex admitted impossible dates (`2026-13-40` → Invalid Date →
  // the preview throws). `.refine` rejects any non-calendar date (month>12, day
  // overflow) by requiring the parsed instant to round-trip to the same YMD. The
  // boundary is anchored to America/Sao_Paulo (UTC-03:00, no DST in this era) —
  // the restaurant's local business day. A `…T00:00:00Z` (UTC) boundary shifted
  // every window edge ~3h forward, excluding the last day's dinner peak from an
  // "ordered between" segment; the explicit offset makes the day boundary local.
  const SAO_PAULO_UTC_OFFSET = "-03:00";
  const startOf = (ymd: string): Date =>
    new Date(`${ymd}T00:00:00${SAO_PAULO_UTC_OFFSET}`);
  const YMD = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => {
      const d = startOf(s);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, "data inválida");
  app.post(
    "/api/admin/broadcast/audience/preview",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Prever o público de um disparo a partir de filtros",
        body: z.object({
          orderedFrom: YMD.optional(),
          orderedTo: YMD.optional(),
          createdFrom: YMD.optional(),
          createdTo: YMD.optional(),
          source: z.string().max(40).optional(),
        }),
        response: {
          200: z.object({
            count: z.number().int(),
            recipients: z.array(z.string()),
            sample: z.array(z.string()),
          }),
          400: z.object({
            statusCode: z.number().int(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const spec = request.body;
      const empty = { count: 0, recipients: [], sample: [] };

      // S5 — refuse an empty spec. With no filter fields the compiled `where` is
      // `{}`, resolving to the ENTIRE non-opted-out customer base — a mass-send
      // footgun where an unrecognized/partial NL segment silently targets everyone.
      // Require at least one explicit filter so the whole base is never previewed
      // (or loaded into the send box) by accident.
      if (
        !spec.orderedFrom &&
        !spec.orderedTo &&
        !spec.createdFrom &&
        !spec.createdTo &&
        !spec.source
      ) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message:
            "Especifique ao menos um filtro de segmento (período de pedido, período de cadastro ou origem). Não é possível pré-visualizar a base inteira.",
        });
      }

      // 1) If an order-date window is given, resolve the customers who ordered in it.
      let orderCustomerIds: string[] | null = null;
      if (spec.orderedFrom || spec.orderedTo) {
        const range: Prisma.DateTimeFilter = {};
        if (spec.orderedFrom) range.gte = startOf(spec.orderedFrom);
        if (spec.orderedTo) range.lt = startOf(spec.orderedTo); // exclusive upper bound
        const orders = await prisma.orderProjection.findMany({
          where: { medusaCreatedAt: range, customerId: { not: null } },
          select: { customerId: true },
          distinct: ["customerId"],
        });
        orderCustomerIds = orders
          .map((o) => o.customerId)
          .filter((v): v is string => Boolean(v));
        if (orderCustomerIds.length === 0) return reply.send(empty);
      }

      // 2) Compile the customer filter (parameterized — whitelisted fields only).
      const where: Prisma.CustomerWhereInput = {};
      if (orderCustomerIds) where.id = { in: orderCustomerIds };
      if (spec.source) where.source = spec.source;
      if (spec.createdFrom || spec.createdTo) {
        const cr: Prisma.DateTimeFilter = {};
        if (spec.createdFrom) cr.gte = startOf(spec.createdFrom);
        if (spec.createdTo) cr.lt = startOf(spec.createdTo);
        where.createdAt = cr;
      }
      const customers = await prisma.customer.findMany({
        where,
        select: { phone: true },
        take: 5000, // the blast hard cap
      });
      // Canonicalize to E.164 so BOTH sides of the consent match are canonical:
      // the consent keys are always E.164, but a legacy/non-canonical
      // `customer.phone` would otherwise evade the opt-out filter (and be
      // returned as a non-canonical recipient the blast can't match). Normalizing
      // here makes the `phone: { in: [...] }` query and the returned recipients
      // canonical on both sides.
      const phones = customers.map((c) => normalizeRecipient(c.phone));
      if (phones.length === 0) return reply.send(empty);

      // 3) Consent filter — never include an opted-out customer in the segment.
      const optedOut = new Set(
        (
          await prisma.customerBroadcastConsent.findMany({
            where: { optedOut: true, phone: { in: phones } },
            select: { phone: true },
          })
        ).map((r) => r.phone),
      );
      const recipients = phones.filter((p) => !optedOut.has(p));
      return reply.send({
        count: recipients.length,
        recipients,
        sample: recipients.slice(0, 20),
      });
    },
  );
}
