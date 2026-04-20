// Admin order action routes.
//
// POST /api/admin/orders/:id/force-cancel  — force cancel any order (MANAGER+)
// POST /api/admin/orders/:id/advance       — advance fulfillment status (ATTENDANT+)
// POST /api/admin/orders/:id/waive         — waive payment (OWNER only)
// POST /api/admin/orders/:id/staff-notes   — add internal staff note (ATTENDANT+)

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderQueryService,
  createPaymentCommandService,
  createPaymentQueryService,
  prisma,
} from "@ibatexas/domain";
import {
  OrderFulfillmentStatus,
  PaymentStatus,
  getNextStatus,
  isTerminalPaymentStatus,
  type OrderStatusChangedEvent,
  type OrderCanceledEvent,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import { requireStaff, requireManager } from "../../middleware/staff-auth.js";

const OrderIdParams = z.object({ id: z.string().min(1) });

export async function adminOrderActionRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const orderCmdSvc = createOrderCommandService();
  const orderQuerySvc = createOrderQueryService();
  const paymentCmdSvc = createPaymentCommandService(server.log);
  const paymentQuerySvc = createPaymentQueryService();

  // ── POST /api/admin/orders/:id/force-cancel ─────────────────────────────
  app.post(
    "/api/admin/orders/:id/force-cancel",
    {
      preHandler: [requireManager],
      schema: {
        tags: ["admin"],
        summary: "Forçar cancelamento do pedido (MANAGER+)",
        params: OrderIdParams,
        body: z.object({ reason: z.string().max(500).optional() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const staffId = request.staffId;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      // Already terminal?
      if (
        order.fulfillmentStatus === OrderFulfillmentStatus.CANCELED ||
        order.fulfillmentStatus === OrderFulfillmentStatus.DELIVERED
      ) {
        return reply.code(422).send({
          error: "Pedido já está em estado terminal.",
          fulfillmentStatus: order.fulfillmentStatus,
        });
      }

      try {
        const result = await orderCmdSvc.transitionStatus(id, {
          newStatus: OrderFulfillmentStatus.CANCELED,
          actor: "admin",
          actorId: staffId,
          reason: request.body.reason ?? "Cancelado pelo admin",
        });

        // Cancel active payment if not terminal
        const activePayment = await paymentQuerySvc.getActiveByOrderId(id).catch(() => null);
        if (activePayment && !isTerminalPaymentStatus(activePayment.status as PaymentStatus)) {
          try {
            await paymentCmdSvc.transitionStatus(activePayment.id, {
              newStatus: PaymentStatus.CANCELED,
              actor: "admin",
              actorId: staffId,
              reason: "Pedido cancelado pelo admin",
            });
          } catch {
            // Payment may already be terminal
          }
        }

        await publishNatsEvent("order.canceled", {
          orderId: id,
          displayId: order.displayId,
          customerId: order.customerId ?? null,
          reason: request.body.reason ?? "Cancelado pelo admin",
          canceledBy: "admin",
          timestamp: new Date().toISOString(),
        } satisfies OrderCanceledEvent);

        return reply.send({
          success: true,
          version: result.version,
          fulfillmentStatus: OrderFulfillmentStatus.CANCELED,
        });
      } catch (err) {
        if ((err as Error).name === "InvalidTransitionError") {
          return reply.code(422).send({ error: "Transição de status inválida." });
        }
        throw err;
      }
    },
  );

  // ── POST /api/admin/orders/:id/advance ──────────────────────────────────
  app.post(
    "/api/admin/orders/:id/advance",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Avançar status do pedido (ATTENDANT+)",
        params: OrderIdParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const staffId = request.staffId;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const nextStatus = getNextStatus(order.fulfillmentStatus as OrderFulfillmentStatus);
      if (!nextStatus) {
        return reply.code(422).send({
          error: "Pedido já está no status final.",
          fulfillmentStatus: order.fulfillmentStatus,
        });
      }

      try {
        const result = await orderCmdSvc.transitionStatus(id, {
          newStatus: nextStatus,
          actor: "admin",
          actorId: staffId,
          reason: `Status avançado por ${request.staffRole}`,
        });

        await publishNatsEvent("order.status_changed", {
          orderId: id,
          displayId: order.displayId,
          previousStatus: order.fulfillmentStatus as OrderFulfillmentStatus,
          newStatus: nextStatus,
          customerId: order.customerId ?? null,
          updatedBy: "admin",
          version: result.version,
          timestamp: new Date().toISOString(),
        } satisfies OrderStatusChangedEvent);

        return reply.send({
          success: true,
          version: result.version,
          previousStatus: order.fulfillmentStatus,
          newStatus: nextStatus,
        });
      } catch (err) {
        if ((err as Error).name === "InvalidTransitionError") {
          return reply.code(422).send({ error: "Transição de status inválida." });
        }
        throw err;
      }
    },
  );

  // ── POST /api/admin/orders/:id/waive ────────────────────────────────────
  app.post(
    "/api/admin/orders/:id/waive",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Isentar pagamento (OWNER only)",
        params: OrderIdParams,
        body: z.object({ reason: z.string().max(500) }),
      },
    },
    async (request, reply) => {
      // OWNER-only gate
      if (request.staffRole !== "OWNER") {
        return reply.code(403).send({ error: "Acesso restrito ao proprietário." });
      }

      const { id } = request.params;
      const staffId = request.staffId;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const activePayment = await paymentQuerySvc.getActiveByOrderId(id).catch(() => null);
      if (!activePayment) {
        return reply.code(404).send({ error: "Nenhum pagamento ativo encontrado." });
      }

      if (isTerminalPaymentStatus(activePayment.status as PaymentStatus)) {
        return reply.code(422).send({
          error: "Pagamento já está em estado terminal.",
          currentStatus: activePayment.status,
        });
      }

      const result = await paymentCmdSvc.transitionStatus(activePayment.id, {
        newStatus: PaymentStatus.WAIVED,
        actor: "admin",
        actorId: staffId,
        reason: request.body.reason,
      });

      await publishNatsEvent("payment.status_changed", {
        orderId: id,
        paymentId: activePayment.id,
        previousStatus: activePayment.status,
        newStatus: PaymentStatus.WAIVED,
        method: activePayment.method,
        version: result.version,
        timestamp: new Date().toISOString(),
      } satisfies PaymentStatusChangedEvent);

      return reply.send({
        success: true,
        version: result.version,
        message: "Pagamento isento.",
      });
    },
  );

  // ── POST /api/admin/orders/:id/staff-notes ──────────────────────────────
  app.post(
    "/api/admin/orders/:id/staff-notes",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Adicionar nota interna do staff",
        params: OrderIdParams,
        body: z.object({ content: z.string().min(1).max(500) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const note = await prisma.orderNote.create({
        data: {
          orderId: id,
          author: "admin",
          authorId: request.staffId ?? undefined,
          content: request.body.content,
          isInternal: true,
        },
      });

      return reply.code(201).send({
        id: note.id,
        content: note.content,
        isInternal: true,
        createdAt: note.createdAt.toISOString(),
      });
    },
  );
}
