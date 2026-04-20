// regenerate_pix tool — generate a new PIX QR code for an order with expired payment
//
// Now uses PaymentCommandService (Phase 2 decoupled billing):
// 1. Validates active payment is in payment_expired state + method is PIX
// 2. Enforces rate limits (3/hr per customer, 5 per order total)
// 3. Transitions old payment → canceled, creates new Payment row → payment_pending
// 4. Creates new Stripe PI, publishes payment.status_changed

import type Stripe from "stripe";
import { NonRetryableError, type AgentContext } from "@ibatexas/types";
import { createPaymentQueryService, createPaymentCommandService } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { withLock } from "../redis/distributed-lock.js";
import { cancelStalePaymentIntent, getStripe } from "./_stripe-helpers.js";

interface RegeneratePixInput {
  orderId: string;
}

interface RegeneratePixOutput {
  success: boolean;
  pixCopyPaste?: string;
  pixQrCode?: string;
  pixExpiresAt?: string;
  message: string;
}

export async function regeneratePix(
  input: RegeneratePixInput,
  ctx: AgentContext,
): Promise<RegeneratePixOutput> {
  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária.");
  }

  const querySvc = createPaymentQueryService();
  const cmdSvc = createPaymentCommandService();

  // Find active payment for this order
  const active = await querySvc.getActiveByOrderId(input.orderId).catch(() => null);

  if (!active) {
    return { success: false, message: "Nenhum pagamento ativo encontrado para este pedido." };
  }

  // Only allow PIX regeneration for expired PIX payments
  if (active.method !== "pix") {
    return { success: false, message: "Regeneração de PIX só é possível para pagamentos PIX." };
  }

  if (active.status !== "payment_expired") {
    return { success: false, message: "O pagamento atual não está expirado." };
  }

  // Rate limit: 3 per hour per customer
  const redis = await getRedisClient();
  const rateLimitKey = rk(`pix:regen:rate:${ctx.customerId}`);
  const count = await redis.incr(rateLimitKey);
  if (count === 1) {
    await redis.expire(rateLimitKey, 3600);
  }
  if (count > 3) {
    return { success: false, message: "Limite de gerações atingido. Tente novamente em 1 hora." };
  }

  // Rate limit: 5 total per order (stored on Payment.regenerationCount)
  const { payments: allAttempts } = await querySvc.listByOrderId(input.orderId);
  const totalRegens = allAttempts.reduce((sum, p) => sum + p.regenerationCount, 0);
  if (totalRegens >= 5) {
    return { success: false, message: "Limite de gerações para este pedido atingido. Entre em contato pelo WhatsApp." };
  }

  // Execute within a lock to prevent race with pix-expiry-checker / webhooks
  const result = await withLock<RegeneratePixOutput>(`payment:${active.id}`, async () => {
    // Re-read to confirm still expired (might have changed while acquiring lock)
    const freshPayment = await querySvc.getById(active.id);
    if (!freshPayment || freshPayment.status !== "payment_expired") {
      return { success: false, message: "O status do pagamento mudou. Atualize a página." };
    }

    // Cancel old Stripe PI if exists
    if (active.stripePaymentIntentId) {
      await cancelStalePaymentIntent(active.stripePaymentIntentId);
    }

    // Transition current payment → canceled (terminal)
    await cmdSvc.transitionStatus(active.id, {
      newStatus: "canceled",
      actor: "customer",
      actorId: ctx.customerId,
      reason: "pix_regeneration",
      expectedVersion: freshPayment.version,
    });

    // Create new Stripe PI with PIX
    const stripe = getStripe();
    const newPi = await stripe.paymentIntents.create({
      amount: active.amountInCentavos,
      currency: "brl",
      payment_method_types: ["pix"],
      metadata: { orderId: input.orderId },
    }) as Stripe.PaymentIntent & {
      next_action?: {
        pix_display_qr_code?: {
          data?: string;
          image_url_svg?: string;
          expires_at?: number;
        };
      };
    };

    const pixExpiresAt = newPi.next_action?.pix_display_qr_code?.expires_at
      ? new Date(newPi.next_action.pix_display_qr_code.expires_at * 1000).toISOString()
      : null;

    // Create new Payment row → payment_pending
    const newPayment = await cmdSvc.create({
      orderId: input.orderId,
      method: "pix",
      amountInCentavos: active.amountInCentavos,
      stripePaymentIntentId: newPi.id,
      pixExpiresAt: pixExpiresAt ? new Date(pixExpiresAt) : undefined,
    });

    // Publish event
    void publishNatsEvent("payment.status_changed", {
      orderId: input.orderId,
      paymentId: newPayment.id,
      previousStatus: "awaiting_payment",
      newStatus: "payment_pending",
      method: "pix",
      version: newPayment.version,
      timestamp: new Date().toISOString(),
    });

    const pixData = newPi.next_action?.pix_display_qr_code;
    if (!pixData?.data) {
      return {
        success: false,
        message: "Erro ao gerar novo PIX. Tente novamente ou escolha outro método de pagamento.",
      };
    }

    return {
      success: true,
      pixCopyPaste: pixData.data,
      pixQrCode: pixData.image_url_svg,
      pixExpiresAt: pixExpiresAt ?? undefined,
      message: "Novo PIX gerado! Use o código abaixo para pagar.",
    };
  });

  // withLock returns null if lock acquisition failed
  return result ?? { success: false, message: "Operação em andamento. Tente novamente em instantes." };
}

export const RegeneratePixTool = {
  name: "regenerate_pix",
  description:
    "Gera um novo código PIX para um pedido com pagamento expirado. Limite: 3 por hora, 5 por pedido.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido" },
    },
    required: ["orderId"],
  },
} as const;
