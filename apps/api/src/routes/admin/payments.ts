// Admin payment control routes.
//
// POST  /api/admin/orders/:id/payment/confirm-cash  — confirm cash received (ATTENDANT+)
// POST  /api/admin/orders/:id/payment/refund        — issue refund (MANAGER+)
// PATCH /api/admin/orders/:id/payment/status        — override payment status (OWNER only)
// POST  /api/admin/orders/:id/notes                 — add admin note (ATTENDANT+)
// GET   /api/admin/orders/:id/notes                 — list notes
// GET   /api/admin/orders/:id/payments              — list all payment attempts

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createPaymentCommandService,
  createPaymentQueryService,
  createOrderQueryService,
  prisma,
} from "@ibatexas/domain";
import {
  PaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import { requireStaff, requireManager, requireManagerRole } from "../../middleware/staff-auth.js";

const OrderIdParams = z.object({ id: z.string().min(1) });

export async function adminPaymentRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const paymentCmdSvc = createPaymentCommandService(server.log);
  const paymentQuerySvc = createPaymentQueryService();
  const orderQuerySvc = createOrderQueryService();

  // ── POST /api/admin/orders/:id/payment/confirm-cash ───────────────────────
  app.post(
    "/api/admin/orders/:id/payment/confirm-cash",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Confirmar recebimento de dinheiro",
        params: OrderIdParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const staffId = request.staffId;

      const payment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!payment) {
        return reply.code(404).send({ error: "Nenhum pagamento ativo encontrado." });
      }

      if (payment.method !== "cash") {
        return reply.code(422).send({ error: "Confirmação de dinheiro disponível apenas para pagamentos em dinheiro." });
      }

      if (payment.status !== "cash_pending") {
        return reply.code(422).send({
          error: "Pagamento não está aguardando confirmação de dinheiro.",
          currentStatus: payment.status,
        });
      }

      const result = await paymentCmdSvc.transitionStatus(payment.id, {
        newStatus: PaymentStatus.PAID,
        actor: "admin",
        actorId: staffId,
        reason: "Dinheiro confirmado pelo atendente",
      });

      await publishNatsEvent("payment.status_changed", {
        eventType: "payment.status_changed",
        orderId: id,
        paymentId: payment.id,
        previousStatus: "cash_pending",
        newStatus: PaymentStatus.PAID,
        method: "cash",
        version: result.version,
        timestamp: new Date().toISOString(),
      } satisfies PaymentStatusChangedEvent & { eventType: string });

      return reply.send({
        success: true,
        version: result.version,
        message: "Pagamento em dinheiro confirmado.",
      });
    },
  );

  // ── POST /api/admin/orders/:id/payment/refund ─────────────────────────────
  app.post(
    "/api/admin/orders/:id/payment/refund",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Emitir reembolso",
        params: OrderIdParams,
        body: z.object({
          amountInCentavos: z.number().int().min(1).optional(), // omit for full refund
          reason: z.string().max(500).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const staffId = request.staffId;

      const payment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!payment) {
        return reply.code(404).send({ error: "Nenhum pagamento ativo encontrado." });
      }

      const refundableStatuses = [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] as string[];
      if (!refundableStatuses.includes(payment.status)) {
        return reply.code(422).send({
          error: "Pagamento não está em estado que permite reembolso.",
          currentStatus: payment.status,
        });
      }

      const refundAmount = request.body.amountInCentavos ?? payment.amountInCentavos;
      const refundableAmount = payment.amountInCentavos - (payment.refundedAmountCentavos ?? 0);

      if (refundAmount > refundableAmount) {
        return reply.code(422).send({
          error: "Valor de reembolso excede o saldo reembolsável.",
          code: "OVER_REFUND",
          maxRefundable: refundableAmount,
        });
      }

      const isFullRefund = refundAmount >= refundableAmount;
      const targetStatus = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

      const result = await paymentCmdSvc.transitionStatus(payment.id, {
        newStatus: targetStatus,
        actor: "admin",
        actorId: staffId,
        reason: request.body.reason ?? "Reembolso emitido pelo admin",
      });

      // Update refunded amount
      await prisma.payment.update({
        where: { id: payment.id },
        data: { refundedAmountCentavos: payment.refundedAmountCentavos + refundAmount },
      });

      await publishNatsEvent("payment.status_changed", {
        eventType: "payment.status_changed",
        orderId: id,
        paymentId: payment.id,
        previousStatus: payment.status,
        newStatus: targetStatus,
        method: payment.method,
        version: result.version,
        timestamp: new Date().toISOString(),
      } satisfies PaymentStatusChangedEvent & { eventType: string });

      return reply.send({
        success: true,
        version: result.version,
        refundedAmount: refundAmount,
        totalRefunded: payment.refundedAmountCentavos + refundAmount,
        newStatus: targetStatus,
      });
    },
  );

  // ── PATCH /api/admin/orders/:id/payment/status ────────────────────────────
  app.patch(
    "/api/admin/orders/:id/payment/status",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Forçar status de pagamento (OWNER)",
        params: OrderIdParams,
        body: z.object({
          status: z.enum([
            "awaiting_payment",
            "payment_pending",
            "payment_expired",
            "payment_failed",
            "cash_pending",
            "paid",
            "switching_method",
            "partially_refunded",
            "refunded",
            "disputed",
            "canceled",
            "waived",
          ]),
          reason: z.string().max(500),
        }),
      },
    },
    async (request, reply) => {
      // OWNER-only gate
      if (request.staffRole !== "OWNER") {
        return reply.code(403).send({ error: "Acesso restrito ao proprietário." });
      }

      const { id } = request.params;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const staffId = request.staffId;

      const payment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!payment) {
        return reply.code(404).send({ error: "Nenhum pagamento ativo encontrado." });
      }

      const result = await paymentCmdSvc.transitionStatus(payment.id, {
        newStatus: request.body.status as PaymentStatus,
        actor: "admin",
        actorId: staffId,
        reason: request.body.reason,
      });

      await publishNatsEvent("payment.status_changed", {
        eventType: "payment.status_changed",
        orderId: id,
        paymentId: payment.id,
        previousStatus: result.previousStatus,
        newStatus: result.newStatus,
        method: payment.method,
        version: result.version,
        timestamp: new Date().toISOString(),
      } satisfies PaymentStatusChangedEvent & { eventType: string });

      return reply.send({
        success: true,
        version: result.version,
        previousStatus: result.previousStatus,
        newStatus: result.newStatus,
      });
    },
  );

  // ── POST /api/admin/orders/:id/notes ──────────────────────────────────────
  app.post(
    "/api/admin/orders/:id/notes",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Adicionar nota administrativa",
        params: OrderIdParams,
        body: z.object({ content: z.string().min(1).max(500) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const note = await prisma.orderNote.create({
        data: {
          orderId: id,
          author: "admin",
          authorId: request.staffId ?? undefined,
          content: request.body.content,
        },
      });

      await publishNatsEvent("order.note_added", {
        eventType: "order.note_added",
        orderId: id,
        noteId: note.id,
        author: "admin",
        timestamp: new Date().toISOString(),
      });

      return reply.code(201).send({ id: note.id, content: note.content, createdAt: note.createdAt.toISOString() });
    },
  );

  // ── GET /api/admin/orders/:id/notes ───────────────────────────────────────
  app.get(
    "/api/admin/orders/:id/notes",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Listar notas do pedido",
        params: OrderIdParams,
      },
    },
    async (request, reply) => {
      const notes = await prisma.orderNote.findMany({
        where: { orderId: request.params.id },
        orderBy: { createdAt: "asc" },
      });

      return reply.send({
        notes: notes.map((n) => ({
          id: n.id,
          author: n.author,
          authorId: n.authorId,
          content: n.content,
          createdAt: n.createdAt.toISOString(),
        })),
      });
    },
  );

  // ── GET /api/admin/orders/:id/payments ────────────────────────────────────
  app.get(
    "/api/admin/orders/:id/payments",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Listar tentativas de pagamento",
        params: OrderIdParams,
      },
    },
    async (request, reply) => {
      const { payments, count } = await paymentQuerySvc.listByOrderId(request.params.id);

      return reply.send({
        payments: payments.map((p) => ({
          id: p.id,
          method: p.method,
          status: p.status,
          amountInCentavos: p.amountInCentavos,
          refundedAmountCentavos: p.refundedAmountCentavos,
          stripePaymentIntentId: p.stripePaymentIntentId,
          pixExpiresAt: p.pixExpiresAt?.toISOString() ?? null,
          regenerationCount: p.regenerationCount,
          version: p.version,
          createdAt: p.createdAt.toISOString(),
        })),
        count,
      });
    },
  );
}
