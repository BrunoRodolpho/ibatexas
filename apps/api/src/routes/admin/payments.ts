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
import { withLock } from "@ibatexas/tools";
import {
  createPaymentCommandService,
  createPaymentQueryService,
  createOrderQueryService,
  prisma,
} from "@ibatexas/domain";
import {
  PaymentStatus,
  isTerminalPaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import type {
  PaymentCashConfirmPayload,
  PaymentRefundIssuePayload,
  PaymentStatusForcePayload,
} from "@ibatexas/pack-payments";
import { requireStaff, requireManagerRole } from "../../middleware/staff-auth.js";
import {
  adjudicateStaffMutation,
  replyForIntent,
} from "../__shared__/customer-intent-gateway.js";

const OrderIdParams = z.object({ id: z.string().min(1) });

// Synthetic actor stamped on a money action (refund) when it is reached via the
// bare ADMIN_API_KEY path rather than a staff JWT (requireManagerRole passes the
// API-key path through, so request.staffId is undefined there). Stamping an
// explicit sentinel guarantees the refund audit trail is never blank-attributed
// (P2-AUTH-REFUNDATTR). It is a fixed identity marker, not config — so it is a
// constant here (not process.env).
const API_KEY_ACTOR_ID = "api-key:admin";

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

      // RC-A1 Phase B — gate cash confirmation (staff TRUSTED path) through the
      // conductor; byte-equivalent legacy path while inert. The transition +
      // status_changed emit is the adjudicated mutation; the HTTP pre-checks
      // (staff auth, order/payment existence, method===cash, status===cash_pending)
      // stay OUTSIDE it. P2-CONC-CONFIRMVER (expectedVersion pin) preserved verbatim.
      const confirmCash = async () => {
        const result = await paymentCmdSvc.transitionStatus(payment.id, {
          newStatus: PaymentStatus.PAID,
          actor: "admin",
          actorId: staffId,
          reason: "Dinheiro confirmado pelo atendente",
          // P2-CONC-CONFIRMVER: pin the version read above. Correctness no longer
          // relies solely on the state machine forbidding cash_pending→cash_pending;
          // a concurrent transition (e.g. a customer switching method, or a second
          // attendant) is rejected with a concurrency error instead of racing.
          expectedVersion: payment.version,
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

        return result;
      };

      const outcome = await adjudicateStaffMutation({
        kind: "payment.cash.confirm",
        payload: {
          orderId: id,
          paymentId: payment.id,
          amountCentavos: payment.amountInCentavos,
          staffId: staffId ?? "staff",
        } satisfies PaymentCashConfirmPayload,
        staffId: staffId ?? "staff",
        // PaymentState for payment.cash.confirm: requirePaymentExists (exists) +
        // executeAll → EXECUTE. exists:true (payment fetched + status-checked above).
        state: { ctx: { actor: { principal: "admin", id: staffId }, exists: true, currentMethod: "cash" } },
        legacy: confirmCash,
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);

      const result = outcome.result;
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

      // P2-AUTH-REFUNDATTR: refund is reachable via the bare ADMIN_API_KEY path
      // (requireManagerRole passes it through when there is no staff JWT), where
      // request.staffId is undefined. Fall back to an explicit synthetic actor so
      // this money action is never recorded with blank attribution. A real staff
      // JWT, when present, still attributes to that staff member.
      const actorId = request.staffId ?? API_KEY_ACTOR_ID;

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

      // Serialize + make the read-check-write atomic per payment. Without a lock,
      // two managers / a double-click both read the same refundedAmountCentavos and
      // both pass the over-refund guard. We acquire withLock, RE-READ inside it, and
      // recompute the refundable amount against fresh state. We bump refundedAmount
      // BEFORE flipping status so a partial failure fails safe (over-counts refunded
      // → blocks further refunds, never enables an over-refund). Full single-write
      // atomicity (status + amount in one write) needs the domain command to accept
      // the amount; tracked for the RC-A1 cutover work.
      // RC-A1 Phase B — adjudicate the refund (staff TRUSTED path) BEFORE running
      // the locked compensating sequence. The magnitude ladder lives in the
      // pack-payments PolicyBundle: ≤R$500 EXECUTE, R$500–1000 REQUEST_CONFIRMATION,
      // >R$1000 ESCALATE (governance §04-decision-policy). We adjudicate with the
      // OUTER-read amounts (the authorization decision); the legacy closure keeps
      // its FULL withLock + fresh re-read + over-refund guard + bump-before-transition
      // (P0-PAY-5 concurrency safety) intact — authorization and concurrency-safety
      // are separate concerns, both preserved.
      //
      // FLIP-TIME BEHAVIOR CHANGE (inert today; fires only post-bootstrap): refunds
      // in the R$500–1000 band become 202 needs-confirmation and >R$1000 become 503
      // escalate, instead of executing directly under manager auth. This is the
      // governance feature the cutover adds — documented, not accidental.
      const outerAlreadyRefunded = payment.refundedAmountCentavos ?? 0;
      const outerRefundable = payment.amountInCentavos - outerAlreadyRefunded;
      const refundAmountForLadder = request.body.amountInCentavos ?? outerRefundable;

      const doRefund = () => withLock(`payment:${payment.id}`, async () => {
        const fresh = await paymentQuerySvc.getById(payment.id);
        if (!fresh) {
          return { code: 404 as const, body: { error: "Pagamento não encontrado." } };
        }
        if (!refundableStatuses.includes(fresh.status)) {
          return {
            code: 422 as const,
            body: { error: "Pagamento não está em estado que permite reembolso.", currentStatus: fresh.status },
          };
        }

        const refundAmount = request.body.amountInCentavos ?? fresh.amountInCentavos;
        const alreadyRefunded = fresh.refundedAmountCentavos ?? 0;
        const refundableAmount = fresh.amountInCentavos - alreadyRefunded;

        if (refundAmount > refundableAmount) {
          return {
            code: 422 as const,
            body: { error: "Valor de reembolso excede o saldo reembolsável.", code: "OVER_REFUND", maxRefundable: refundableAmount },
          };
        }

        const isFullRefund = refundAmount >= refundableAmount;
        const targetStatus = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
        const totalRefunded = alreadyRefunded + refundAmount;

        // Fail-safe ordering: bump the tracked refunded amount first, then transition.
        await prisma.payment.update({
          where: { id: fresh.id },
          data: { refundedAmountCentavos: totalRefunded },
        });
        const result = await paymentCmdSvc.transitionStatus(fresh.id, {
          newStatus: targetStatus,
          actor: "admin",
          actorId,
          reason: request.body.reason ?? "Reembolso emitido pelo admin",
        });

        return {
          code: 200 as const,
          version: result.version,
          refundAmount,
          totalRefunded,
          targetStatus,
          previousStatus: fresh.status,
          method: fresh.method,
        };
      });

      const staffOutcome = await adjudicateStaffMutation({
        kind: "payment.refund.issue",
        payload: {
          paymentId: payment.id,
          refundAmountCentavos: refundAmountForLadder,
          refundableBalanceCentavos: outerRefundable,
          amountInCentavos: payment.amountInCentavos,
          currentRefundedCentavos: outerAlreadyRefunded,
          actor: "admin",
          actorId,
          reason: request.body.reason,
        } satisfies PaymentRefundIssuePayload,
        staffId: actorId,
        // PaymentState for payment.refund.issue: requirePaymentExists (exists) +
        // refuseTerminalTransition (isTerminal — false here, refundableStatuses are
        // PAID/PARTIALLY_REFUNDED, neither terminal) + refundMagnitudeGuard
        // (refundedAmountCentavos vs payload.currentRefundedCentavos — equal, no
        // divergence; the legacy closure does the authoritative fresh-state check).
        state: {
          ctx: {
            actor: { principal: "admin", id: actorId },
            exists: true,
            isTerminal: isTerminalPaymentStatus(payment.status as PaymentStatus),
            refundedAmountCentavos: outerAlreadyRefunded,
            amountInCentavos: payment.amountInCentavos,
          },
        },
        legacy: doRefund,
      });
      if (!staffOutcome.ran) return replyForIntent(reply, staffOutcome.intent);
      const outcome = staffOutcome.result;

      if (!outcome) {
        return reply.code(409).send({
          error: "Outro reembolso para este pagamento está em andamento. Tente novamente.",
          code: "REFUND_IN_PROGRESS",
        });
      }
      if (outcome.code !== 200) {
        return reply.code(outcome.code).send(outcome.body);
      }

      await publishNatsEvent("payment.status_changed", {
        eventType: "payment.status_changed",
        orderId: id,
        paymentId: payment.id,
        previousStatus: outcome.previousStatus,
        newStatus: outcome.targetStatus,
        method: outcome.method,
        version: outcome.version,
        timestamp: new Date().toISOString(),
      } satisfies PaymentStatusChangedEvent & { eventType: string });

      return reply.send({
        success: true,
        version: outcome.version,
        refundedAmount: outcome.refundAmount,
        totalRefunded: outcome.totalRefunded,
        newStatus: outcome.targetStatus,
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

      // RC-A1 Phase B — gate the OWNER force-status override through the conductor;
      // byte-equivalent legacy path while inert. The transition + status_changed
      // emit is the adjudicated mutation; the OWNER-only gate + existence checks stay
      // OUTSIDE it.
      //
      // FLIP-TIME BEHAVIOR CHANGE (inert today; fires only post-bootstrap): the pack
      // maps payment.status.force to ALWAYS REQUEST_CONFIRMATION (confirmAlwaysOnStatusForce)
      // — a manual force-override is intentionally a two-step action. Post-flip this
      // returns 202 needs-confirmation rather than executing directly. Documented,
      // governance-intended. (Also: the pack REFUSEs force on a terminal payment,
      // which the legacy route did not pre-check — the state machine rejected it via
      // InvalidTransitionError instead; net behaviour is equivalent — terminal stays
      // unmovable — with a cleaner audited refusal post-flip.)
      const forceStatus = async () => {
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

        return result;
      };

      const outcome = await adjudicateStaffMutation({
        kind: "payment.status.force",
        payload: {
          paymentId: payment.id,
          newStatus: request.body.status,
          reason: request.body.reason,
          adminId: staffId ?? "owner",
        } satisfies PaymentStatusForcePayload,
        staffId: staffId ?? "owner",
        // PaymentState for payment.status.force: requirePaymentExists (exists) +
        // refuseTerminalTransition (isTerminal) + confirmAlwaysOnStatusForce.
        state: {
          ctx: {
            actor: { principal: "admin", id: staffId },
            exists: true,
            isTerminal: isTerminalPaymentStatus(payment.status as PaymentStatus),
            currentStatus: payment.status,
          },
        },
        legacy: forceStatus,
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);

      const result = outcome.result;
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
        take: 200,
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
