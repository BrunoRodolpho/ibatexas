// Admin order action routes.
//
// POST /api/admin/orders/:id/force-cancel          — step 1: request confirmation (MANAGER+)
// POST /api/admin/orders/:id/force-cancel/confirm  — step 2: consume receipt + execute
// POST /api/admin/orders/:id/advance               — advance fulfillment status (ATTENDANT+)
// POST /api/admin/orders/:id/waive                 — step 1: request confirmation (OWNER)
// POST /api/admin/orders/:id/waive/confirm         — step 2: consume receipt + execute
// POST /api/admin/orders/:id/staff-notes           — add internal staff note (ATTENDANT+)
//
// ── Task 13 (M3) — admin force-* governance ─────────────────────────────
//
// `force-cancel` and `waive` are destructive: they can put the order /
// payment in a terminal state from any non-terminal predecessor. Per
// investigation 02 P0 #4 and the M3 admin-governance brief, these
// routes now flow through:
//
//   1. **REQUEST_CONFIRMATION step** — operator POSTs the action body.
//      The route validates role + state, then stores a pending action
//      receipt in Redis (10-min TTL) keyed by a fresh UUID. The body
//      returned (202) carries `{confirmationId, prompt, ttlSeconds}`.
//      No mutation runs. The receipt's `nonce` is fixed at this step.
//
//   2. **EXECUTE step** — operator POSTs to `/confirm` with the receipt
//      id. The route atomically consumes the receipt via Lua (GET+DEL)
//      and dispatches the `*FromEnvelope` call on the command service.
//      The kernel adjudicates and emits an audit record carrying the
//      operator's identity (`actor.principal`, `actor.sessionId`). The
//      executed nonce matches step 1 → identical `intentHash` (audit
//      dedup remains safe even on operator retries).
//
// ── Auth model preserved ─────────────────────────────────────────────────
//
// `requireManager` / OWNER role gates remain on the destructive routes;
// adjudicate is layered ON TOP, not replacing role-based auth. The
// envelope's actor metadata records both layers:
//   - `actor.principal = "user"` for staff JWT-authenticated calls.
//   - `actor.principal = "system"` for API-key-only (no JWT) calls.
//   - `actor.sessionId` encodes staffId or `"api-key"`.
//   - `taint = "TRUSTED"` for staff JWT.
//   - `taint = "SYSTEM"` for API key.
//
// ── pt-BR ────────────────────────────────────────────────────────────────
//
// All operator-facing prompts and error messages are pt-BR per
// CLAUDE.md rule #4. The structured machine fields (kind, principal,
// taint) remain in English by convention.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { buildEnvelope } from "@adjudicate/core";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderEventLogService,
  createOrderQueryService,
  createPaymentCommandService,
  createPaymentQueryService,
  prisma,
  type OrderStatusTransitionPayload,
  type PaymentStatusTransitionPayload,
} from "@ibatexas/domain";
import type {
  OrderNoteAddPayload,
  OrderState,
} from "@ibatexas/pack-orders";
import { getAuditSink } from "@ibatexas/audit-sink";
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
import {
  ACTOR_TYPE_MISMATCH_REFUSAL_PT_BR,
  consumeWithSameActorCheck,
  createAdminConfirmationStore,
  NULL_STAFF_REFUSAL_PT_BR,
  SAME_ACTOR_REFUSAL_PT_BR,
  type PendingAdminAction,
} from "./admin-confirmation-store.js";

const OrderIdParams = z.object({ id: z.string().min(1) });

const ConfirmationBody = z.object({
  confirmationId: z.string().min(1).max(64),
});

/**
 * Derive envelope `actor` + `taint` from the authenticated request.
 *
 * `requireManager` / `requireStaff` ensure `request.staffId` is set on
 * JWT-authenticated routes; the outer admin guard accepts API-key
 * callers too (no staff identity). When `staffId` is null we treat
 * the caller as `"system"` with `SYSTEM` taint — same convention as
 * the Stripe webhook and customer route migrations.
 */
function principalFor(staffId: string | null): {
  readonly actorPrincipal: "user" | "system";
  readonly taint: "TRUSTED" | "SYSTEM";
  readonly sessionId: string;
} {
  if (staffId) {
    return {
      actorPrincipal: "user",
      taint: "TRUSTED",
      sessionId: `admin:${staffId}`,
    };
  }
  return {
    actorPrincipal: "system",
    taint: "SYSTEM",
    sessionId: "admin:api-key",
  };
}

export async function adminOrderActionRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  // Defer audit-sink resolution to onReady (see adminPaymentRoutes for
  // the full rationale — boot-order race between plugin-body execution
  // during buildServer() and bootstrapAuditSinkDI() in index.ts).
  let orderCmdSvc!: ReturnType<typeof createOrderCommandService>;
  let paymentCmdSvc!: ReturnType<typeof createPaymentCommandService>;
  server.addHook("onReady", async () => {
    orderCmdSvc = createOrderCommandService(server.log, {
      auditSink: getAuditSink(),
    });
    paymentCmdSvc = createPaymentCommandService(server.log, {
      auditSink: getAuditSink(),
    });
  });
  const orderQuerySvc = createOrderQueryService();
  const paymentQuerySvc = createPaymentQueryService();
  const eventLogSvc = createOrderEventLogService(server.log);
  const confirmationStore = createAdminConfirmationStore();

  // ── POST /api/admin/orders/:id/force-cancel (step 1) ─────────────────────
  app.post(
    "/api/admin/orders/:id/force-cancel",
    {
      preHandler: [requireManager],
      schema: {
        tags: ["admin"],
        summary: "Forçar cancelamento do pedido — etapa 1 (MANAGER+)",
        params: OrderIdParams,
        body: z.object({ reason: z.string().max(500).optional() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const staffId = request.staffId ?? null;
      const staffRole = request.staffRole ?? null;

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

      // ── Build pending action ────────────────────────────────────────
      // The nonce is captured here so step 2 reconstructs the SAME
      // envelope (identical intentHash) — load-bearing for audit dedup.
      //
      // audit-2026-05-24 P2-5: snapshot `order.version` at step 1 so
      // step 2 can pass it as `expectedVersion` into the envelope. The
      // executor REFUSEs (ConcurrencyError) if the projection advanced
      // between the two operator clicks.
      const reason = request.body.reason ?? "Cancelado pelo admin";
      const { actorPrincipal } = principalFor(staffId);
      const expectedVersion = order.version;

      const payload: OrderStatusTransitionPayload = {
        orderId: id,
        newStatus: OrderFulfillmentStatus.CANCELED,
        actor: "admin",
        ...(staffId ? { actorId: staffId } : {}),
        reason,
      };
      const pending: PendingAdminAction = {
        kind: "order.status.transition",
        payload: payload as unknown as Record<string, unknown>,
        nonce: randomUUID(),
        staffId,
        staffRole,
        actorPrincipal,
        requestorIp: request.ip ?? null,
        prompt:
          "Cancelamento forçado do pedido. Esta ação coloca o pedido em estado terminal e cancela o pagamento ativo. Confirma?",
        route: "force-cancel",
        createdAt: new Date().toISOString(),
        orderId: id,
        reason,
        expectedVersion,
      };

      const { confirmationId, ttlSeconds } =
        await confirmationStore.create(pending);

      // Best-effort audit preamble — records that a confirmation was
      // requested, so even abandoned receipts leave a trail.
      await eventLogSvc.append({
        orderId: id,
        eventType: "admin.force_cancel.requested",
        discriminator: `${confirmationId}`,
        payload: {
          confirmationId,
          staffId,
          staffRole,
          requestorIp: pending.requestorIp,
          reason,
          intentNonce: pending.nonce,
        },
        timestamp: new Date(),
      });

      return reply.code(202).send({
        confirmationId,
        prompt: pending.prompt,
        ttlSeconds,
        kind: pending.kind,
      });
    },
  );

  // ── POST /api/admin/orders/:id/force-cancel/confirm (step 2) ─────────────
  app.post(
    "/api/admin/orders/:id/force-cancel/confirm",
    {
      preHandler: [requireManager],
      schema: {
        tags: ["admin"],
        summary: "Forçar cancelamento do pedido — etapa 2 (MANAGER+)",
        params: OrderIdParams,
        body: ConfirmationBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { confirmationId } = request.body;
      const staffId = request.staffId ?? null;
      const { actorPrincipal: requestActorPrincipal } = principalFor(staffId);

      const consumed = await consumeWithSameActorCheck(
        confirmationStore,
        confirmationId,
        staffId,
        requestActorPrincipal,
      );
      if (consumed.kind === "missing") {
        return reply.code(410).send({
          error: "Confirmação inválida, expirada ou já utilizada.",
        });
      }
      if (consumed.kind === "null_staff_violation") {
        // P0-5-TRUE: two-person rule requires two identifiable staff
        // members. An API-key step on either side cannot satisfy it.
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.force_cancel.null_staff_refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            pendingStaffId: consumed.pending.staffId,
            reason: consumed.reason,
          },
          timestamp: new Date(),
        });
        return reply.code(403).send({ error: NULL_STAFF_REFUSAL_PT_BR });
      }
      if (consumed.kind === "actor_type_mismatch") {
        // P0-5-TRUE: actor-type mismatch — same human bouncing between
        // credential paths defeats separation-of-duty.
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.force_cancel.actor_type_mismatch_refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            pendingActor: consumed.pendingActor,
            requestActor: consumed.requestActor,
          },
          timestamp: new Date(),
        });
        return reply
          .code(403)
          .send({ error: ACTOR_TYPE_MISMATCH_REFUSAL_PT_BR });
      }
      if (consumed.kind === "same_actor_violation") {
        // P0-5: another operator must confirm step 2. Receipt is
        // already drained — operator restarts from step 1.
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.force_cancel.same_actor_refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            pendingStaffId: consumed.pending.staffId,
          },
          timestamp: new Date(),
        });
        return reply.code(403).send({ error: SAME_ACTOR_REFUSAL_PT_BR });
      }
      const pending = consumed.pending;
      if (pending.route !== "force-cancel" || pending.orderId !== id) {
        return reply.code(410).send({
          error: "Confirmação inválida, expirada ou já utilizada.",
        });
      }

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      if (
        order.fulfillmentStatus === OrderFulfillmentStatus.CANCELED ||
        order.fulfillmentStatus === OrderFulfillmentStatus.DELIVERED
      ) {
        return reply.code(422).send({
          error: "Pedido já está em estado terminal.",
          fulfillmentStatus: order.fulfillmentStatus,
        });
      }

      const { actorPrincipal, taint, sessionId } = principalFor(staffId);
      const storedPayload = pending.payload as unknown as OrderStatusTransitionPayload;
      // audit-2026-05-24 P2-5: thread the step-1 version into the
      // envelope payload so the executor's optimistic-concurrency check
      // fires if another mutation has bumped `order.version` between
      // the two operator clicks.
      const payload: OrderStatusTransitionPayload = {
        ...storedPayload,
        ...(pending.expectedVersion !== undefined
          ? { expectedVersion: pending.expectedVersion }
          : {}),
      };
      const envelope = buildEnvelope<
        "order.status.transition",
        OrderStatusTransitionPayload
      >({
        kind: "order.status.transition",
        payload,
        nonce: pending.nonce,
        actor: { principal: actorPrincipal, sessionId },
        taint,
      });

      try {
        const outcome = await orderCmdSvc.transitionStatusFromEnvelope(envelope);
        if (
          outcome.decision.kind !== "EXECUTE" &&
          outcome.decision.kind !== "REWRITE"
        ) {
          // REFUSE / DEFER / ESCALATE / REQUEST_CONFIRMATION at the
          // kernel layer (e.g., projection not found, terminal state).
          const refusalText =
            outcome.decision.kind === "REFUSE"
              ? outcome.decision.refusal.userFacing
              : "Operação não permitida pela política do kernel.";
          await eventLogSvc.append({
            orderId: id,
            eventType: "admin.force_cancel.refused",
            discriminator: confirmationId,
            payload: {
              confirmationId,
              staffId,
              decision: outcome.decision.kind,
              intentHash: envelope.intentHash,
            },
            timestamp: new Date(),
          });
          return reply.code(403).send({ error: refusalText });
        }

        const result = outcome.result!;

        // Cancel active payment if not terminal — preserves legacy behavior.
        const activePayment = await paymentQuerySvc
          .getActiveByOrderId(id)
          .catch(() => null);
        if (
          activePayment &&
          !isTerminalPaymentStatus(activePayment.status as PaymentStatus)
        ) {
          try {
            const paymentPayload: PaymentStatusTransitionPayload = {
              paymentId: activePayment.id,
              newStatus: PaymentStatus.CANCELED,
              actor: "admin",
              ...(staffId ? { actorId: staffId } : {}),
              reason: "Pedido cancelado pelo admin",
            };
            const paymentEnvelope = buildEnvelope({
              kind: "payment.status.transition" as const,
              payload: paymentPayload,
              nonce: randomUUID(),
              actor: { principal: actorPrincipal, sessionId },
              taint,
            });
            await paymentCmdSvc.transitionStatusFromEnvelope(paymentEnvelope);
          } catch {
            // Payment may already be terminal — non-fatal.
          }
        }

        await publishNatsEvent("order.canceled", {
          orderId: id,
          displayId: order.displayId,
          customerId: order.customerId ?? null,
          reason: pending.reason ?? "Cancelado pelo admin",
          canceledBy: "admin",
          timestamp: new Date().toISOString(),
        } satisfies OrderCanceledEvent);

        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.force_cancel.executed",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            staffRole: pending.staffRole,
            intentHash: envelope.intentHash,
            decision: outcome.decision.kind,
            version: result.version,
          },
          timestamp: new Date(),
        });

        return reply.send({
          success: true,
          version: result.version,
          fulfillmentStatus: OrderFulfillmentStatus.CANCELED,
          confirmationId,
        });
      } catch (err) {
        if ((err as Error).name === "InvalidTransitionError") {
          return reply.code(422).send({ error: "Transição de status inválida." });
        }
        // audit-2026-05-24 P2-5: surface optimistic-concurrency conflicts
        // as 409 with the canonical receipt-stale message. The operator
        // must restart from step 1.
        if ((err as Error).name === "ConcurrencyError") {
          await eventLogSvc.append({
            orderId: id,
            eventType: "admin.force_cancel.stale_version_refused",
            discriminator: confirmationId,
            payload: {
              confirmationId,
              staffId,
              expectedVersion: pending.expectedVersion ?? null,
              message: (err as Error).message,
            },
            timestamp: new Date(),
          });
          return reply.code(409).send({
            error: "Pedido foi atualizado por outro atendente após a aprovação. Reabra a operação.",
          });
        }
        throw err;
      }
    },
  );

  // ── POST /api/admin/orders/:id/advance ──────────────────────────────────
  // Non-destructive — does NOT require the two-step confirmation flow.
  // Migrated to envelope dispatch per task 15.
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
      const staffId = request.staffId ?? null;

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

      const { actorPrincipal, taint, sessionId } = principalFor(staffId);
      const payload: OrderStatusTransitionPayload = {
        orderId: id,
        newStatus: nextStatus,
        actor: "admin",
        ...(staffId ? { actorId: staffId } : {}),
        reason: `Status avançado por ${request.staffRole}`,
      };
      const envelope = buildEnvelope<
        "order.status.transition",
        OrderStatusTransitionPayload
      >({
        kind: "order.status.transition",
        payload,
        nonce: randomUUID(),
        actor: { principal: actorPrincipal, sessionId },
        taint,
      });

      try {
        const outcome = await orderCmdSvc.transitionStatusFromEnvelope(envelope);
        if (
          outcome.decision.kind !== "EXECUTE" &&
          outcome.decision.kind !== "REWRITE"
        ) {
          const refusalText =
            outcome.decision.kind === "REFUSE"
              ? outcome.decision.refusal.userFacing
              : "Operação não permitida pela política do kernel.";
          return reply.code(403).send({ error: refusalText });
        }
        const result = outcome.result!;

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

  // ── POST /api/admin/orders/:id/waive (step 1) ───────────────────────────
  app.post(
    "/api/admin/orders/:id/waive",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Isentar pagamento — etapa 1 (OWNER)",
        params: OrderIdParams,
        body: z.object({ reason: z.string().max(500) }),
      },
    },
    async (request, reply) => {
      // OWNER-only gate — preserved.
      if (request.staffRole !== "OWNER") {
        return reply.code(403).send({ error: "Acesso restrito ao proprietário." });
      }

      const { id } = request.params;
      const staffId = request.staffId ?? null;
      const staffRole = request.staffRole ?? null;

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

      const { actorPrincipal } = principalFor(staffId);
      // audit-2026-05-24 P2-5: snapshot `payment.version` at step 1 so
      // step 2 carries `expectedVersion` into the envelope payload.
      const expectedVersion = activePayment.version;
      const payload: PaymentStatusTransitionPayload = {
        paymentId: activePayment.id,
        newStatus: PaymentStatus.WAIVED,
        actor: "admin",
        ...(staffId ? { actorId: staffId } : {}),
        reason: request.body.reason,
      };
      const pending: PendingAdminAction = {
        kind: "payment.status.transition",
        payload: payload as unknown as Record<string, unknown>,
        nonce: randomUUID(),
        staffId,
        staffRole,
        actorPrincipal,
        requestorIp: request.ip ?? null,
        prompt:
          "Isenção de pagamento. Esta ação coloca o pagamento em estado terminal (WAIVED) sem cobrança. Confirma?",
        route: "waive",
        createdAt: new Date().toISOString(),
        orderId: id,
        reason: request.body.reason,
        expectedVersion,
      };

      const { confirmationId, ttlSeconds } =
        await confirmationStore.create(pending);

      await eventLogSvc.append({
        orderId: id,
        eventType: "admin.waive.requested",
        discriminator: confirmationId,
        payload: {
          confirmationId,
          staffId,
          staffRole,
          paymentId: activePayment.id,
          reason: request.body.reason,
          intentNonce: pending.nonce,
        },
        timestamp: new Date(),
      });

      return reply.code(202).send({
        confirmationId,
        prompt: pending.prompt,
        ttlSeconds,
        kind: pending.kind,
      });
    },
  );

  // ── POST /api/admin/orders/:id/waive/confirm (step 2) ───────────────────
  app.post(
    "/api/admin/orders/:id/waive/confirm",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Isentar pagamento — etapa 2 (OWNER)",
        params: OrderIdParams,
        body: ConfirmationBody,
      },
    },
    async (request, reply) => {
      if (request.staffRole !== "OWNER") {
        return reply.code(403).send({ error: "Acesso restrito ao proprietário." });
      }

      const { id } = request.params;
      const { confirmationId } = request.body;
      const staffId = request.staffId ?? null;
      const { actorPrincipal: requestActorPrincipal } = principalFor(staffId);

      const consumed = await consumeWithSameActorCheck(
        confirmationStore,
        confirmationId,
        staffId,
        requestActorPrincipal,
      );
      if (consumed.kind === "missing") {
        return reply.code(410).send({
          error: "Confirmação inválida, expirada ou já utilizada.",
        });
      }
      if (consumed.kind === "null_staff_violation") {
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.waive.null_staff_refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            pendingStaffId: consumed.pending.staffId,
            reason: consumed.reason,
          },
          timestamp: new Date(),
        });
        return reply.code(403).send({ error: NULL_STAFF_REFUSAL_PT_BR });
      }
      if (consumed.kind === "actor_type_mismatch") {
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.waive.actor_type_mismatch_refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            pendingActor: consumed.pendingActor,
            requestActor: consumed.requestActor,
          },
          timestamp: new Date(),
        });
        return reply
          .code(403)
          .send({ error: ACTOR_TYPE_MISMATCH_REFUSAL_PT_BR });
      }
      if (consumed.kind === "same_actor_violation") {
        // P0-5: another operator must confirm step 2.
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.waive.same_actor_refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            pendingStaffId: consumed.pending.staffId,
          },
          timestamp: new Date(),
        });
        return reply.code(403).send({ error: SAME_ACTOR_REFUSAL_PT_BR });
      }
      const pending = consumed.pending;
      if (pending.route !== "waive" || pending.orderId !== id) {
        return reply.code(410).send({
          error: "Confirmação inválida, expirada ou já utilizada.",
        });
      }

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

      const { actorPrincipal, taint, sessionId } = principalFor(staffId);
      const storedPayload = pending.payload as unknown as PaymentStatusTransitionPayload;
      // Ensure the payment id in the receipt still matches today's active
      // payment — defensive against an active payment swap between the two
      // steps.
      if (storedPayload.paymentId !== activePayment.id) {
        return reply.code(409).send({
          error: "Pagamento ativo divergente. Reabra a operação.",
        });
      }

      // audit-2026-05-24 P2-5: thread the step-1 version into the
      // envelope payload. If the payment has been mutated between
      // step 1 and step 2 the executor will throw ConcurrencyError.
      const envelopePayload: PaymentStatusTransitionPayload = {
        ...storedPayload,
        ...(pending.expectedVersion !== undefined
          ? { expectedVersion: pending.expectedVersion }
          : {}),
      };
      const envelope = buildEnvelope<
        "payment.status.transition",
        PaymentStatusTransitionPayload
      >({
        kind: "payment.status.transition",
        payload: envelopePayload,
        nonce: pending.nonce,
        actor: { principal: actorPrincipal, sessionId },
        taint,
      });

      let outcome;
      try {
        outcome = await paymentCmdSvc.transitionStatusFromEnvelope(envelope);
      } catch (err) {
        // audit-2026-05-24 P2-5: optimistic-concurrency conflict — the
        // payment advanced between step 1 and step 2. Surface 409 with
        // the canonical receipt-stale message.
        if ((err as Error).name === "PaymentConcurrencyError") {
          await eventLogSvc.append({
            orderId: id,
            eventType: "admin.waive.stale_version_refused",
            discriminator: confirmationId,
            payload: {
              confirmationId,
              staffId,
              expectedVersion: pending.expectedVersion ?? null,
              message: (err as Error).message,
            },
            timestamp: new Date(),
          });
          return reply.code(409).send({
            error: "Pagamento foi atualizado por outro atendente após a aprovação. Reabra a operação.",
          });
        }
        throw err;
      }
      if (
        outcome.decision.kind !== "EXECUTE" &&
        outcome.decision.kind !== "REWRITE"
      ) {
        const refusalText =
          outcome.decision.kind === "REFUSE"
            ? outcome.decision.refusal.userFacing
            : "Operação não permitida pela política do kernel.";
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.waive.refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            decision: outcome.decision.kind,
            intentHash: envelope.intentHash,
          },
          timestamp: new Date(),
        });
        return reply.code(403).send({ error: refusalText });
      }

      const result = outcome.result!;

      await publishNatsEvent("payment.status_changed", {
        orderId: id,
        paymentId: activePayment.id,
        previousStatus: activePayment.status,
        newStatus: PaymentStatus.WAIVED,
        method: activePayment.method,
        version: result.version,
        timestamp: new Date().toISOString(),
      } satisfies PaymentStatusChangedEvent);

      await eventLogSvc.append({
        orderId: id,
        eventType: "admin.waive.executed",
        discriminator: confirmationId,
        payload: {
          confirmationId,
          staffId,
          staffRole: pending.staffRole,
          paymentId: activePayment.id,
          intentHash: envelope.intentHash,
          decision: outcome.decision.kind,
          version: result.version,
        },
        timestamp: new Date(),
      });

      return reply.send({
        success: true,
        version: result.version,
        message: "Pagamento isento.",
        confirmationId,
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

      // W7-P4: route the staff internal note through addNoteFromEnvelope so
      // the order.note.add intent is kernel-adjudicated and audit-emitted.
      // The Wave-6 finding flagged the direct prisma.orderNote.create as a
      // parallel/duplicate surface bypass. isInternal=true is passed via
      // the payload so the pack-orders policy can observe it; pack-orders
      // currently honors the field through OrderNoteAddPayload.isInternal.
      const staffId = request.staffId ?? null;
      const noteEnvelope = buildEnvelope<
        "order.note.add",
        OrderNoteAddPayload
      >({
        kind: "order.note.add" as const,
        payload: {
          orderId: id,
          body: request.body.content,
          isInternal: true,
        },
        nonce: randomUUID(),
        actor: staffId
          ? { principal: "user", sessionId: `admin:${staffId}` }
          : { principal: "system", sessionId: "admin:api-key" },
        taint: staffId ? "TRUSTED" : "SYSTEM",
      });
      const noteOrderState: OrderState = {
        ctx: {
          channel: "web",
          customerId: order.customerId,
          cartId: null,
          orderId: id,
          paymentMethod: (order.paymentMethod as
            | "pix"
            | "card"
            | "cash"
            | null) ?? null,
          paymentStatus: order.paymentStatus,
          totalInCentavos: order.totalInCentavos,
        },
      };
      const outcome = await orderCmdSvc.addNoteFromEnvelope(
        noteEnvelope,
        noteOrderState,
        {
          author: "staff",
          ...(staffId ? { authorId: staffId } : {}),
        },
      );

      if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
        const message =
          outcome.decision.kind === "REFUSE"
            ? outcome.decision.refusal.userFacing
            : "Não foi possível adicionar a nota interna no momento.";
        return reply.code(403).send({ error: message });
      }

      const noteResult = outcome.result!;
      const persisted = await prisma.orderNote.findUnique({
        where: { id: noteResult.noteId },
      });

      return reply.code(201).send({
        id: noteResult.noteId,
        content: persisted?.content ?? request.body.content,
        isInternal: true,
        createdAt:
          persisted?.createdAt?.toISOString() ?? new Date().toISOString(),
      });
    },
  );
}
