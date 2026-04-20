// cancel_order tool — cancel a Medusa order if eligible (with PONR check)
//
// Phase 2 enhancement: also cancels the active Payment row if not already paid.

import { CancelOrderInputSchema, NonRetryableError, type CancelOrderInput, type AgentContext } from "@ibatexas/types";
import { createOrderService, createPaymentQueryService, createPaymentCommandService } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { medusaAdmin } from "../medusa/client.js";
import { cancelStalePaymentIntent } from "./_stripe-helpers.js";

export async function cancelOrder(
  input: CancelOrderInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string; needsEscalation?: boolean }> {
  const parsed = CancelOrderInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para cancelar pedido.");
  }

  const svc = createOrderService(medusaAdmin);
  const result = await svc.cancelOrder(parsed.orderId, ctx.customerId);

  // If order cancellation succeeded, also cancel the active Payment
  if (result.success) {
    try {
      const paymentQuerySvc = createPaymentQueryService();
      const paymentCmdSvc = createPaymentCommandService();

      const activePayment = await paymentQuerySvc.getActiveByOrderId(parsed.orderId).catch(() => null);

      if (activePayment) {
        const PAID_STATUSES = ["paid", "refunded", "canceled", "waived"];
        if (!PAID_STATUSES.includes(activePayment.status)) {
          // Cancel Stripe PI if exists
          if (activePayment.stripePaymentIntentId) {
            await cancelStalePaymentIntent(activePayment.stripePaymentIntentId);
          }

          // Transition payment → canceled
          await paymentCmdSvc.transitionStatus(activePayment.id, {
            newStatus: "canceled",
            actor: "customer",
            actorId: ctx.customerId,
            reason: "order_canceled",
            expectedVersion: activePayment.version,
          });

          void publishNatsEvent("payment.status_changed", {
            orderId: parsed.orderId,
            paymentId: activePayment.id,
            previousStatus: activePayment.status,
            newStatus: "canceled",
            method: activePayment.method,
            version: activePayment.version + 1,
            timestamp: new Date().toISOString(),
          });
        }
      }
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
