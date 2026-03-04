// create_checkout tool — initialize payment session and return checkout data
//
// For PIX: returns Stripe PIX QR code from payment intent (confirmed via Stripe webhook)
// For card: returns Stripe payment intent client secret
// For cash: completes directly and publishes order.placed
//
// IMPORTANT: PIX and card orders are only confirmed via Stripe webhook —
// never by client polling alone to avoid stuck-pending orders.

import type { AgentContext } from "@ibatexas/types";
import { medusaStoreFetch, medusaAdminFetch } from "./_shared.js";
import { publishNatsEvent } from "@ibatexas/nats-client";
import Stripe from "stripe";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
}

export interface CreateCheckoutInput {
  cartId: string;
  paymentMethod: "pix" | "card" | "cash";
  tipInCentavos?: number;
  deliveryCep?: string;
}

export interface CreateCheckoutOutput {
  success: boolean;
  paymentMethod: string;
  // PIX
  pixQrCodeUrl?: string;
  pixQrCodeText?: string;
  pixExpiresAt?: string;
  // Card
  stripeClientSecret?: string;
  // Cash
  orderId?: string;
  message: string;
}

export async function createCheckout(
  input: CreateCheckoutInput,
  ctx: AgentContext,
): Promise<CreateCheckoutOutput> {
  const { cartId, paymentMethod, tipInCentavos, deliveryCep } = input;

  // 1. Update cart metadata with tip and delivery CEP
  const metadata: Record<string, string> = {};
  if (tipInCentavos) metadata["tipInCentavos"] = String(tipInCentavos);
  if (deliveryCep) metadata["deliveryCep"] = deliveryCep;
  if (ctx.customerId) metadata["customerId"] = ctx.customerId;

  await medusaStoreFetch(`/store/carts/${cartId}`, {
    method: "POST",
    body: JSON.stringify({ metadata }),
  });

  // 2. Initialize payment sessions
  const sessionData = await medusaStoreFetch(`/store/carts/${cartId}/payment-sessions`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  if (paymentMethod === "cash") {
    // Complete cart directly for cash payment
    const completedData = await medusaStoreFetch(`/store/carts/${cartId}/complete`, {
      method: "POST",
      body: JSON.stringify({ payment_provider_id: "cash" }),
    }) as { order?: { id: string } };

    const orderId = completedData.order?.id;
    if (orderId) {
      await publishNatsEvent("ibatexas.order.placed", {
        eventType: "order.placed",
        orderId,
        paymentMethod: "cash",
        customerId: ctx.customerId,
      });
    }

    return {
      success: true,
      paymentMethod: "cash",
      orderId,
      message: orderId
        ? `Pedido realizado com sucesso (#${orderId})! Pagamento em dinheiro na entrega.`
        : "Pedido realizado! Pagamento em dinheiro na entrega.",
    };
  }

  // 3. For PIX/card: get the Stripe PaymentIntent client secret from the session
  const cart = sessionData as {
    cart?: {
      payment_sessions?: Array<{
        provider_id: string;
        data?: { client_secret?: string; id?: string };
      }>;
    };
  };

  const stripeSession = cart.cart?.payment_sessions?.find(
    (s) => s.provider_id?.includes("stripe"),
  );
  const clientSecret = stripeSession?.data?.client_secret;
  const paymentIntentId = stripeSession?.data?.id;

  if (!clientSecret) {
    return {
      success: false,
      paymentMethod,
      message:
        "Não foi possível inicializar o pagamento. Tente novamente ou escolha pagamento em dinheiro.",
    };
  }

  if (paymentMethod === "card") {
    return {
      success: true,
      paymentMethod: "card",
      stripeClientSecret: clientSecret,
      message:
        "Sessão de pagamento com cartão iniciada. Use o client_secret para finalizar no frontend.",
    };
  }

  // PIX — retrieve QR code from Stripe
  if (paymentMethod === "pix" && paymentIntentId) {
    try {
      const stripe = getStripe();
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId) as Stripe.PaymentIntent & {
        next_action?: {
          pix_display_qr_code?: {
            data?: string;
            image_url_svg?: string;
            expires_at?: number;
          };
        };
      };

      const pixData = pi.next_action?.pix_display_qr_code;

      return {
        success: true,
        paymentMethod: "pix",
        pixQrCodeUrl: pixData?.image_url_svg,
        pixQrCodeText: pixData?.data,
        pixExpiresAt: pixData?.expires_at
          ? new Date(pixData.expires_at * 1000).toISOString()
          : undefined,
        message: pixData?.data
          ? "PIX gerado com sucesso! Escaneie o QR code ou copie o código PIX. O pedido é confirmado automaticamente após o pagamento."
          : "PIX iniciado. Finalize o pagamento no app do seu banco.",
      };
    } catch (err) {
      console.error("[create_checkout] PIX QR retrieval error:", err);
      return {
        success: false,
        paymentMethod: "pix",
        // Include paymentIntentId so the order can be recovered
        orderId: paymentIntentId,
        message:
          "Erro ao gerar QR Code PIX. Seu pedido foi iniciado — entre em contato se o problema persistir. Referência: " +
          paymentIntentId,
      };
    }
  }

  return {
    success: false,
    paymentMethod,
    message: "Método de pagamento não suportado.",
  };
}

export const CreateCheckoutTool = {
  name: "create_checkout",
  description:
    "Inicia o processo de checkout. Para PIX retorna QR code; para cartão retorna client secret; para dinheiro confirma o pedido diretamente. PIX e cartão são confirmados via webhook Stripe.",
  inputSchema: {
    type: "object",
    properties: {
      cartId: { type: "string", description: "ID do carrinho" },
      paymentMethod: {
        type: "string",
        enum: ["pix", "card", "cash"],
        description: "Método de pagamento: pix, card (cartão) ou cash (dinheiro na entrega)",
      },
      tipInCentavos: {
        type: "number",
        description: "Gorjeta em centavos (opcional). Ex: 1000 = R$10,00",
      },
      deliveryCep: {
        type: "string",
        description: "CEP de entrega (obrigatório para delivery)",
      },
    },
    required: ["cartId", "paymentMethod"],
  },
} as const;
