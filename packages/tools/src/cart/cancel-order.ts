// cancel_order tool — cancel a Medusa order if eligible (with PONR check)

import { CancelOrderInputSchema, NonRetryableError, type CancelOrderInput, type AgentContext } from "@ibatexas/types";
import { createOrderService } from "@ibatexas/domain";
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

  // Cancel the Stripe PaymentIntent to prevent late PIX scans on cancelled orders
  if (result.success) {
    const { order } = await svc.getOrder(parsed.orderId);
    const piId = order.metadata?.["stripePaymentIntentId"];
    if (piId) {
      await cancelStalePaymentIntent(piId);
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
