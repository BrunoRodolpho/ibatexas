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
  type OrderStatusTransitionPayload,
  type PaymentStatusTransitionPayload,
} from "@ibatexas/domain";
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
  createAdminConfirmationStore,
  type PendingAdminAction,
} from "./admin-confirmation-store.js";
import {
  adjudicateAdminNote,
  buildAdminTransitionEnvelope,
  consumeAndGateAdminAction,
  kernelRefusalText,
  logStaleVersionRefusal,
  principalFor,
  refuseTransitionWithLog,
} from "./_shared-actions.js";

const OrderIdParams = z.object({ id: z.string().min(1) });

const ConfirmationBody = z.object({
  confirmationId: z.string().min(1).max(64),
});

/**
 * Best-effort cancellation of an order's active payment after a forced
 * order cancellation. Mirrors the legacy inline behavior exactly: skips
 * when no active payment exists or it is already terminal, and swallows
 * any transition error (the payment may already be terminal — non-fatal).
 */
async function cancelActivePaymentBestEffort(deps: {
  readonly paymentQuerySvc: ReturnType<typeof createPaymentQueryService>;
  readonly paymentCmdSvc: ReturnType<typeof createPaymentCommandService>;
  readonly orderId: string;
  readonly staffId: string | null;
  readonly actorPrincipal: "user" | "system";
  readonly taint: "TRUSTED" | "SYSTEM";
  readonly sessionId: string;
}): Promise<void> {
  const {
    paymentQuerySvc,
    paymentCmdSvc,
    orderId,
    staffId,
    actorPrincipal,
    taint,
    sessionId,
  } = deps;
  const activePayment = await paymentQuerySvc
    .getActiveByOrderId(orderId)
    .catch(() => null);
  if (
    !activePayment ||
    isTerminalPaymentStatus(activePayment.status as PaymentStatus)
  ) {
    return;
  }
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

  // Behavior-preserving extraction of the order-existence + terminal-state
  // guard duplicated between force-cancel step 1 and force-cancel confirm.
  // Returns a reply descriptor (`ok: false`) or the loaded order
  // (`ok: true`); the early-return shape is unchanged.
  async function loadNonTerminalOrder(orderId: string): Promise<
    | {
        readonly ok: false;
        readonly code: number;
        readonly body: Record<string, unknown>;
      }
    | {
        readonly ok: true;
        readonly order: NonNullable<
          Awaited<ReturnType<typeof orderQuerySvc.getById>>
        >;
      }
  > {
    const order = await orderQuerySvc.getById(orderId);
    if (!order) {
      return { ok: false, code: 404, body: { error: "Pedido não encontrado." } };
    }
    if (
      order.fulfillmentStatus === OrderFulfillmentStatus.CANCELED ||
      order.fulfillmentStatus === OrderFulfillmentStatus.DELIVERED
    ) {
      return {
        ok: false,
        code: 422,
        body: {
          error: "Pedido já está em estado terminal.",
          fulfillmentStatus: order.fulfillmentStatus,
        },
      };
    }
    return { ok: true, order };
  }

  // Behavior-preserving extraction of the order + active-payment load +
  // terminal-state guard duplicated between waive step 1 and waive confirm.
  // `getById` has no catch; `getActiveByOrderId` swallows errors to null —
  // identical to the previous inline blocks.
  async function loadWaiveContext(orderId: string): Promise<
    | {
        readonly ok: false;
        readonly code: number;
        readonly body: Record<string, unknown>;
      }
    | {
        readonly ok: true;
        readonly order: NonNullable<
          Awaited<ReturnType<typeof orderQuerySvc.getById>>
        >;
        readonly activePayment: NonNullable<
          Awaited<ReturnType<typeof paymentQuerySvc.getActiveByOrderId>>
        >;
      }
  > {
    const order = await orderQuerySvc.getById(orderId);
    if (!order) {
      return { ok: false, code: 404, body: { error: "Pedido não encontrado." } };
    }
    const activePayment = await paymentQuerySvc
      .getActiveByOrderId(orderId)
      .catch(() => null);
    if (!activePayment) {
      return {
        ok: false,
        code: 404,
        body: { error: "Nenhum pagamento ativo encontrado." },
      };
    }
    if (isTerminalPaymentStatus(activePayment.status as PaymentStatus)) {
      return {
        ok: false,
        code: 422,
        body: {
          error: "Pagamento já está em estado terminal.",
          currentStatus: activePayment.status,
        },
      };
    }
    return { ok: true, order, activePayment };
  }

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

      const loaded = await loadNonTerminalOrder(id);
      if (!loaded.ok) {
        return reply.code(loaded.code).send(loaded.body);
      }
      const order = loaded.order;

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

      // Two-person separation-of-duty + receipt validity gate. The
      // refusal kinds (missing / null_staff / actor_type_mismatch /
      // same_actor / wrong-route) each emit their own audit entry inside
      // the helper; P0-5 / P0-5-TRUE rules are unchanged.
      const gate = await consumeAndGateAdminAction({
        confirmationStore,
        eventLogSvc,
        confirmationId,
        orderId: id,
        staffId,
        eventPrefix: "admin.force_cancel",
        expectedRoute: "force-cancel",
      });
      if (!gate.ok) {
        return reply.code(gate.code).send({ error: gate.error });
      }
      const pending = gate.pending;

      const loaded = await loadNonTerminalOrder(id);
      if (!loaded.ok) {
        return reply.code(loaded.code).send(loaded.body);
      }
      const order = loaded.order;

      // audit-2026-05-24 P2-5: the step-1 version is threaded into the
      // envelope payload (inside buildAdminTransitionEnvelope) so the
      // executor's optimistic-concurrency check fires if another mutation
      // has bumped `order.version` between the two operator clicks.
      const { envelope, actorPrincipal, taint, sessionId } =
        buildAdminTransitionEnvelope<
          "order.status.transition",
          OrderStatusTransitionPayload
        >({ pending, staffId, kind: "order.status.transition" });

      try {
        const outcome = await orderCmdSvc.transitionStatusFromEnvelope(envelope);
        if (
          outcome.decision.kind !== "EXECUTE" &&
          outcome.decision.kind !== "REWRITE"
        ) {
          // REFUSE / DEFER / ESCALATE / REQUEST_CONFIRMATION at the
          // kernel layer (e.g., projection not found, terminal state).
          return await refuseTransitionWithLog({
            eventLogSvc,
            reply,
            orderId: id,
            confirmationId,
            staffId,
            eventType: "admin.force_cancel.refused",
            decisionKind: outcome.decision.kind,
            intentHash: envelope.intentHash,
            refusalText: kernelRefusalText(outcome.decision),
          });
        }

        const result = outcome.result!;

        // Cancel active payment if not terminal — preserves legacy behavior.
        await cancelActivePaymentBestEffort({
          paymentQuerySvc,
          paymentCmdSvc,
          orderId: id,
          staffId,
          actorPrincipal,
          taint,
          sessionId,
        });

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
          const refusalText = kernelRefusalText(outcome.decision);
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

      const loaded = await loadWaiveContext(id);
      if (!loaded.ok) {
        return reply.code(loaded.code).send(loaded.body);
      }
      const activePayment = loaded.activePayment;

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

      // Two-person separation-of-duty + receipt validity gate (P0-5 /
      // P0-5-TRUE rules unchanged; each refusal kind emits its own audit
      // entry inside the helper).
      const gate = await consumeAndGateAdminAction({
        confirmationStore,
        eventLogSvc,
        confirmationId,
        orderId: id,
        staffId,
        eventPrefix: "admin.waive",
        expectedRoute: "waive",
      });
      if (!gate.ok) {
        return reply.code(gate.code).send({ error: gate.error });
      }
      const pending = gate.pending;

      const loaded = await loadWaiveContext(id);
      if (!loaded.ok) {
        return reply.code(loaded.code).send(loaded.body);
      }
      const activePayment = loaded.activePayment;

      const storedPayload = pending.payload as unknown as PaymentStatusTransitionPayload;
      // Ensure the payment id in the receipt still matches today's active
      // payment — defensive against an active payment swap between the two
      // steps.
      if (storedPayload.paymentId !== activePayment.id) {
        return reply.code(409).send({
          error: "Pagamento ativo divergente. Reabra a operação.",
        });
      }

      // audit-2026-05-24 P2-5: the step-1 version is threaded into the
      // envelope payload (inside buildAdminTransitionEnvelope). If the
      // payment has been mutated between step 1 and step 2 the executor
      // will throw ConcurrencyError.
      const { envelope } = buildAdminTransitionEnvelope<
        "payment.status.transition",
        PaymentStatusTransitionPayload
      >({ pending, staffId, kind: "payment.status.transition" });

      let outcome;
      try {
        outcome = await paymentCmdSvc.transitionStatusFromEnvelope(envelope);
      } catch (err) {
        // audit-2026-05-24 P2-5: optimistic-concurrency conflict — the
        // payment advanced between step 1 and step 2. Surface 409 with
        // the canonical receipt-stale message.
        if ((err as Error).name === "PaymentConcurrencyError") {
          return await logStaleVersionRefusal({
            eventLogSvc,
            reply,
            orderId: id,
            confirmationId,
            staffId,
            eventType: "admin.waive.stale_version_refused",
            expectedVersion: pending.expectedVersion ?? null,
            message: (err as Error).message,
          });
        }
        throw err;
      }
      if (
        outcome.decision.kind !== "EXECUTE" &&
        outcome.decision.kind !== "REWRITE"
      ) {
        return refuseTransitionWithLog({
          eventLogSvc,
          reply,
          orderId: id,
          confirmationId,
          staffId,
          eventType: "admin.waive.refused",
          decisionKind: outcome.decision.kind,
          intentHash: envelope.intentHash,
          refusalText: kernelRefusalText(outcome.decision),
        });
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
      // isInternal=true is carried in the payload so the pack-orders policy
      // can observe it (see adjudicateAdminNote in _shared-actions.ts).
      const staffId = request.staffId ?? null;
      const note = await adjudicateAdminNote({
        orderCmdSvc,
        order,
        orderId: id,
        staffId,
        content: request.body.content,
        isInternal: true,
      });

      if (note.kind === "refused") {
        const message = kernelRefusalText(
          note.decision,
          "Não foi possível adicionar a nota interna no momento.",
        );
        return reply.code(403).send({ error: message });
      }

      return reply.code(201).send({
        id: note.noteId,
        content: note.persisted?.content ?? request.body.content,
        isInternal: true,
        createdAt:
          note.persisted?.createdAt?.toISOString() ?? new Date().toISOString(),
      });
    },
  );
}
