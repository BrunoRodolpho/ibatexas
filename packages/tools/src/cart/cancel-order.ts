// cancel_order tool — cancel a Medusa order if eligible (with PONR check)
//
// Phase 2 enhancement: also cancels the active Payment row if not already paid.
//
// ── R1-DELETE (W1 correctness remediation) ────────────────────────────────
//
// Payment cancellation now goes through `transitionStatusFromEnvelope`.
// The previous bare-arg `paymentCmdSvc.transitionStatus(...)` bypassed
// kernel adjudication.

import { randomUUID } from "node:crypto";
import { buildEnvelope } from "@adjudicate/core";
import { CancelOrderInputSchema, NonRetryableError, type CancelOrderInput, type AgentContext } from "@ibatexas/types";
import {
  createPaymentQueryService,
  createPaymentCommandService,
  type PaymentStatusTransitionPayload,
} from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { createTooledOrderService } from "./_shared.js";
import { cancelStalePaymentIntent } from "./_stripe-helpers.js";

// Best-effort cancellation of the active Payment row tied to a just-canceled order.
// Routes the status transition through the kernel-adjudicated envelope path.
async function cancelActivePaymentForOrder(
  orderId: string,
  customerId: string,
): Promise<void> {
  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService();

  const activePayment = await paymentQuerySvc.getActiveByOrderId(orderId).catch(() => null);
  if (!activePayment) return;

  const PAID_STATUSES = ["paid", "refunded", "canceled", "waived"];
  if (PAID_STATUSES.includes(activePayment.status)) return;

  // Cancel Stripe PI if exists
  if (activePayment.stripePaymentIntentId) {
    await cancelStalePaymentIntent(activePayment.stripePaymentIntentId);
  }

  // Transition payment → canceled via the kernel-adjudicated path.
  const cancelEnvelope = buildEnvelope<
    "payment.status.transition",
    PaymentStatusTransitionPayload
  >({
    kind: "payment.status.transition",
    payload: {
      paymentId: activePayment.id,
      newStatus: "canceled",
      actor: "customer",
      actorId: customerId,
      reason: "order_canceled",
      expectedVersion: activePayment.version,
    },
    nonce: randomUUID(),
    actor: { principal: "user", sessionId: customerId },
    taint: "TRUSTED",
  });
  await paymentCmdSvc.transitionStatusFromEnvelope(cancelEnvelope);

  void publishNatsEvent("payment.status_changed", {
    orderId,
    paymentId: activePayment.id,
    previousStatus: activePayment.status,
    newStatus: "canceled",
    method: activePayment.method,
    version: activePayment.version + 1,
    timestamp: new Date().toISOString(),
  });
}

export async function cancelOrder(
  input: CancelOrderInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string; needsEscalation?: boolean }> {
  const parsed = CancelOrderInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para cancelar pedido.");
  }

  // W8-V1: route order.service mutations through the kernel-gated wrapper
  // via the shared factory. Replaces the pre-W8 bare `createOrderService(medusaAdmin)`
  // which silently fell back to bare fetchAdmin (no kernel, no audit).
  const svc = createTooledOrderService("tool:cancel_order");
  const result = await svc.cancelOrder(parsed.orderId, ctx.customerId);

  // If order cancellation succeeded, also cancel the active Payment
  if (result.success) {
    try {
      await cancelActivePaymentForOrder(parsed.orderId, ctx.customerId);
    } catch (paymentErr) {
      // Log but don't fail — order is already canceled, payment cleanup is best-effort
      console.error("[cancel_order] Failed to cancel payment:", (paymentErr as Error).message);
    }

    // Also cancel Stripe PI from order metadata (legacy path)
    try {
      const { order } = await svc.getOrder(parsed.orderId);
      const piId = order.metadata?.["stripePaymentIntentId"];
      if (piId) {
        await cancelStalePaymentIntent(piId);
      }
    } catch {
      // Best effort
    }
  }

  // Escalate to admin if PONR expired or status prevents cancellation
  if (result.needsEscalation) {
    void publishNatsEvent("order.escalation_needed", {
      orderId: parsed.orderId,
      customerId: ctx.customerId,
      reason: "cancel_past_ponr",
      timestamp: new Date().toISOString(),
    });
  }

  return result;
}

export const CancelOrderTool = {
  name: "cancel_order",
  description: "Cancela um pedido. Verifica prazo de cancelamento (PONR). Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido a cancelar" },
    },
    required: ["orderId"],
  },
} as const;
