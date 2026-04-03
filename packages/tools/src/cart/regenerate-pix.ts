// regenerate_pix tool — generate a new PIX QR code for a pending order
// Used when the customer's previous PIX expired but the order is still active.

import type Stripe from "stripe";
import { NonRetryableError, type AgentContext } from "@ibatexas/types";
import { createOrderService } from "@ibatexas/domain";
import { medusaAdmin } from "../medusa/client.js";
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

  const svc = createOrderService(medusaAdmin);
  const { order, ownershipValid } = await svc.getOrder(input.orderId, ctx.customerId);

  if (!ownershipValid) {
    return { success: false, message: "Pedido não encontrado." };
  }

  // Only allow regeneration for pending/requires_action orders
  const allowedStatuses = ["pending", "requires_action"];
  if (!allowedStatuses.includes(order.status)) {
    return { success: false, message: "Este pedido não aceita mais pagamento PIX." };
  }

  // Cancel old PI if exists
  const oldPiId = order.metadata?.["stripePaymentIntentId"];
  if (oldPiId) {
    await cancelStalePaymentIntent(oldPiId);
  }

  // Fetch current order total
  const { order: freshOrder } = await svc.getOrder(input.orderId);
  const total = freshOrder.total ?? 0;
  if (total <= 0) {
    return { success: false, message: "Total do pedido inválido." };
  }

  // Create new Stripe PaymentIntent with PIX
  const stripe = getStripe();
  const newPi = await stripe.paymentIntents.create({
    amount: total,
    currency: "brl",
    payment_method_types: ["pix"],
    metadata: { medusaOrderId: input.orderId },
  }) as Stripe.PaymentIntent & {
    next_action?: {
      pix_display_qr_code?: {
        data?: string;
        image_url_svg?: string;
        expires_at?: number;
      };
    };
  };

  // Update order metadata with new PI ID
  await medusaAdmin(`/admin/orders/${input.orderId}`, {
    method: "POST",
    body: JSON.stringify({
      metadata: { stripePaymentIntentId: newPi.id },
    }),
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
    pixExpiresAt: pixData.expires_at
      ? new Date(pixData.expires_at * 1000).toISOString()
      : undefined,
    message: "Novo PIX gerado! Use o código abaixo para pagar.",
  };
}

export const RegeneratePixTool = {
  name: "regenerate_pix",
  description:
    "Gera um novo código PIX para um pedido pendente. Use quando o PIX anterior expirou.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido" },
    },
    required: ["orderId"],
  },
} as const;
