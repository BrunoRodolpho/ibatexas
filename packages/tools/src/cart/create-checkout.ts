// create_checkout tool — initialize payment session and return checkout data
//
// For PIX: returns Stripe PIX QR code from payment intent (confirmed via Stripe webhook)
// For card: returns Stripe payment intent client secret
// For cash: completes directly and publishes order.placed
//
// IMPORTANT: PIX and card orders are only confirmed via Stripe webhook —
// never by client polling alone to avoid stuck-pending orders.

import Stripe from "stripe";
import { CreateCheckoutInputSchema, NonRetryableError, formatOrderId, type CreateCheckoutInput, type AgentContext } from "@ibatexas/types";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { reaisToCentavos } from "../medusa/client.js";
import { loadSchedule } from "../cache/schedule-cache.js";
import { getAndConsumeWelcomeCredit } from "../intelligence/welcome-credit.js";
import { getMealPeriodFromSchedule } from "../schedule/schedule-helpers.js";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { medusaStoreFetch } from "./_shared.js";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
}

export interface CreateCheckoutOutput {
  success: boolean;
  paymentMethod: string;
  // PIX
  pixQrCode?: string;
  pixCopyPaste?: string;
  pixExpiresAt?: string;
  // Card
  stripeClientSecret?: string;
  // Cash
  orderId?: string;
  message: string;
}

// PIX billing details required by Stripe:
//   - name (customer full name)
//   - email (customer email address)
//   - tax_id (CPF for individuals, CNPJ for businesses — required for US-based Stripe accounts)
// Ref: https://docs.stripe.com/payments/pix/accept-a-payment

interface PixCustomerInfo {
  name?: string;
  email?: string;
  taxId?: string; // CPF or CNPJ
}

const PIX_EXPIRY_SECONDS = Number.parseInt(process.env.PIX_EXPIRY_SECONDS || "3600", 10); // 1h default

async function confirmPixAndGetQrCode(
  paymentIntentId: string,
  customer: PixCustomerInfo,
  cartId: string,
  customerId?: string,
): Promise<CreateCheckoutOutput> {
  try {
    const stripe = getStripe();
    const returnUrl = process.env.RESTAURANT_SITE_URL ?? process.env.NEXT_PUBLIC_URL ?? "https://ibatexas.com.br";

    console.warn("[create_checkout] Confirming PI %s with PIX (name=%s email=%s)",
      paymentIntentId, customer.name ?? "fallback", customer.email ? "present" : "fallback");

    // PIX requires: name, email, tax_id (CPF/CNPJ)
    // WhatsApp users don't provide email or CPF — use restaurant defaults
    const taxId = customer.taxId || process.env.PIX_FALLBACK_TAX_ID;

    const confirmed = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method_data: {
        type: "pix",
        billing_details: {
          name: customer.name || "Cliente IbateXas",
          email: customer.email || process.env.PIX_FALLBACK_EMAIL || "pedido@ibatexas.com.br",
          ...(taxId ? { tax_id: taxId } : {}),
        },
      },
      payment_method_options: {
        pix: { expires_after_seconds: PIX_EXPIRY_SECONDS },
      },
      return_url: `${returnUrl}/order/confirmation`,
    }) as Stripe.PaymentIntent & {
      next_action?: {
        pix_display_qr_code?: {
          data?: string;
          image_url_svg?: string;
          image_url_png?: string;
          expires_at?: number;
          hosted_instructions_url?: string;
        };
      };
    };

    console.warn("[create_checkout] PI status=%s next_action=%s", confirmed.status, !!confirmed.next_action);

    const pixData = confirmed.next_action?.pix_display_qr_code;

    if (!pixData?.data && !pixData?.image_url_svg) {
      console.error("[create_checkout] Stripe PI has no PIX QR data after confirm:", paymentIntentId);
      return {
        success: false,
        paymentMethod: "pix",
        message: "Não foi possível gerar o QR Code PIX. Tente novamente ou escolha pagamento em dinheiro.",
      };
    }

    // Store cartId in PaymentIntent metadata so the webhook can complete
    // the cart and create the Medusa order when PIX payment succeeds.
    // Cart completion must NOT happen here — the payment session is not
    // authorized yet (customer hasn't scanned the QR code).
    try {
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: { cartId },
      });
    } catch (err) {
      console.warn("[create_checkout] Failed to set cartId metadata on PI:", (err as Error).message);
    }

    // Track pending checkout so /account/orders can show it before webhook fires
    if (customerId) {
      try {
        const redis = await getRedisClient();
        await redis.hSet(rk(`customer:pending-orders:${customerId}`), paymentIntentId, JSON.stringify({
          paymentIntentId,
          cartId,
          paymentMethod: "pix",
          createdAt: new Date().toISOString(),
        }));
        await redis.expire(rk(`customer:pending-orders:${customerId}`), 86400 * 7); // 7 days
      } catch {
        // Non-critical
      }
    }

    return {
      success: true,
      paymentMethod: "pix",
      orderId: paymentIntentId,
      pixQrCode: pixData.image_url_svg ?? pixData.image_url_png,
      pixCopyPaste: pixData.data,
      pixExpiresAt: pixData.expires_at
        ? new Date(pixData.expires_at * 1000).toISOString()
        : undefined,
      message: "PIX gerado com sucesso! Escaneie o QR code ou copie o código PIX. O pedido é confirmado automaticamente após o pagamento.",
    };
  } catch (err) {
    console.error("[create_checkout] PIX confirm error:", (err as Error).message);
    return {
      success: false,
      paymentMethod: "pix",
      orderId: paymentIntentId,
      message:
        "Erro ao gerar QR Code PIX. Seu pedido foi iniciado — entre em contato se o problema persistir. Referência: " +
        paymentIntentId,
    };
  }
}

export async function createCheckout(
  input: CreateCheckoutInput,
  ctx: AgentContext,
  extra?: { customerName?: string; customerEmail?: string; customerTaxId?: string },
): Promise<CreateCheckoutOutput> {
  const parsed = CreateCheckoutInputSchema.parse(input);
  const { cartId, paymentMethod, tipInCentavos, deliveryCep } = parsed;

  // Verify cart total > 0 before proceeding with checkout
  const cartData = await medusaStoreFetch(`/store/carts/${cartId}`) as {
    cart?: { total?: number; items?: unknown[] };
  };
  const cartTotal = cartData.cart?.total ?? 0;
  if (cartTotal <= 0) {
    throw new NonRetryableError(
      "Carrinho vazio ou com valor zero. Adicione itens antes de finalizar o pedido.",
    );
  }

  // Apply welcome credit if available (first-time customer coupon)
  if (ctx.customerId) {
    try {
      const welcomeCode = await getAndConsumeWelcomeCredit(ctx.customerId);
      if (welcomeCode) {
        await medusaStoreFetch(`/store/carts/${cartId}/promotions`, {
          method: "POST",
          body: JSON.stringify({ promo_codes: [welcomeCode] }),
        });
        console.warn(`[checkout] Welcome credit ${welcomeCode} applied for customer ${ctx.customerId}`);
      }
    } catch (err) {
      // Medusa rejected the code (expired, already used, or not configured) — continue without discount
      console.warn(`[checkout] Welcome credit application failed for customer ${ctx.customerId}: ${(err as Error).message}`);
    }
  }

  // 1. Update cart metadata with tip and delivery CEP
  const metadata: Record<string, string> = {};
  if (tipInCentavos) metadata["tipInCentavos"] = String(tipInCentavos);
  if (deliveryCep) metadata["deliveryCep"] = deliveryCep;
  if (ctx.customerId) metadata["customerId"] = ctx.customerId;
  metadata["deliveryType"] = deliveryCep ? "delivery" : "pickup";
  metadata["paymentMethod"] = paymentMethod;

  // Mark scheduled-pickup orders: pickup (no deliveryCep) + restaurant currently closed
  // These orders are preserved when PIX expires so the customer can regenerate payment at pickup
  if (!deliveryCep) {
    try {
      const schedule = await loadSchedule();
      const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
      const mealPeriod = getMealPeriodFromSchedule(schedule, tz);
      if (mealPeriod === "closed") {
        metadata["scheduledPickup"] = "true";
      }
    } catch {
      // If schedule lookup fails, omit the flag — safe to continue without it
    }
  }

  await medusaStoreFetch(`/store/carts/${cartId}`, {
    method: "POST",
    body: JSON.stringify({ metadata }),
  });

  // 2. Get or create payment collection (Medusa v2 flow)
  const cartForPC = await medusaStoreFetch(`/store/carts/${cartId}`) as {
    cart?: {
      payment_collection?: { id: string };
      items?: Array<{
        variant_id: string;
        title?: string;
        quantity: number;
        unit_price: number;
        variant?: { product_id?: string; title?: string };
      }>;
    };
  };
  let paymentCollectionId = cartForPC.cart?.payment_collection?.id;

  if (!paymentCollectionId) {
    const pcData = await medusaStoreFetch(`/store/payment-collections`, {
      method: "POST",
      body: JSON.stringify({ cart_id: cartId }),
    }) as { payment_collection?: { id: string } };
    paymentCollectionId = pcData.payment_collection?.id;
  }

  if (!paymentCollectionId) {
    return {
      success: false,
      paymentMethod,
      message: "Não foi possível inicializar o pagamento. Tente novamente.",
    };
  }

  // 3. Resolve the payment provider ID dynamically from Medusa
  //    (avoids hardcoding — the ID format varies by Medusa version + config)
  let providerId: string;
  if (paymentMethod === "cash") {
    providerId = "pp_system_default";
  } else {
    // Query registered providers and find the Stripe one
    const cartRegion = cartForPC.cart as { region_id?: string } | undefined;
    const regionParam = cartRegion?.region_id ? `?region_id=${cartRegion.region_id}` : "";
    try {
      const providersData = await medusaStoreFetch(`/store/payment-providers${regionParam}`) as {
        payment_providers?: Array<{ id: string; is_enabled?: boolean }>;
      };
      const stripeProvider = providersData.payment_providers?.find(
        (p) => p.id.includes("stripe"),
      );
      providerId = stripeProvider?.id ?? "pp_stripe_stripe";
      console.warn("[create_checkout] Resolved Stripe provider_id: %s", providerId);
    } catch {
      // Fallback to common default
      providerId = "pp_stripe_stripe";
      console.warn("[create_checkout] Could not query payment providers — using default: %s", providerId);
    }
  }

  // 4. Initialize payment session on the payment collection
  const rawSessionData = await medusaStoreFetch(
    `/store/payment-collections/${paymentCollectionId}/payment-sessions`,
    {
      method: "POST",
      body: JSON.stringify({ provider_id: providerId }),
    },
  );

  // Debug: log the response shape to diagnose Stripe data extraction
  console.warn("[create_checkout] payment session response: %s", JSON.stringify(rawSessionData).slice(0, 1500));

  // Medusa v2 response shape varies — try multiple extraction paths
  const sessionObj = rawSessionData as Record<string, unknown>;
  const paymentSession = (
    sessionObj.payment_session ??
    (sessionObj.payment_collection as Record<string, unknown> | undefined)?.payment_sessions?.[0 as never]
  ) as { id?: string; provider_id?: string; data?: Record<string, unknown> } | undefined;

  // Stripe data can be nested directly in the session or under data.
  // Extract client_secret and payment intent ID from all possible paths
  const stripeData = paymentSession?.data ?? paymentSession ?? {};
  const clientSecret = (stripeData as { client_secret?: string }).client_secret;
  const paymentIntentId = (stripeData as { id?: string }).id;

  console.warn("[create_checkout] extracted clientSecret=%s paymentIntentId=%s",
    clientSecret ? "present" : "MISSING",
    paymentIntentId ?? "MISSING",
  );

  if (paymentMethod === "cash") {
    // Extract cart items for the order.placed event
    const cartItems = (cartForPC.cart?.items ?? []).map((item) => ({
      productId: item.variant?.product_id ?? "",
      variantId: item.variant_id,
      title: item.title ?? item.variant?.title ?? "",
      quantity: item.quantity,
      priceInCentavos: reaisToCentavos(item.unit_price),
    }));

    // Complete cart directly for cash payment
    const completedData = await medusaStoreFetch(`/store/carts/${cartId}/complete`, {
      method: "POST",
      body: JSON.stringify({}),
    }) as { type?: string; order?: { id: string; display_id?: number; total?: number; subtotal?: number; shipping_total?: number } };

    const rawOrderId = completedData.order?.id;
    const orderId = completedData.order?.display_id
      ? formatOrderId(completedData.order.display_id)
      : rawOrderId;

    if (rawOrderId) {
      void publishNatsEvent("order.placed", {
        eventType: "order.placed",
        orderId: rawOrderId,
        displayId: completedData.order?.display_id ?? 0,
        paymentMethod: "cash",
        paymentStatus: "cash_pending",
        customerId: ctx.customerId,
        customerEmail: null,
        customerName: null,
        customerPhone: null,
        totalInCentavos: reaisToCentavos(completedData.order?.total ?? 0),
        subtotalInCentavos: reaisToCentavos(completedData.order?.subtotal ?? 0),
        shippingInCentavos: reaisToCentavos(completedData.order?.shipping_total ?? 0),
        deliveryType: metadata["deliveryType"] ?? "pickup",
        tipInCentavos: tipInCentavos ?? 0,
        items: cartItems,
      }).catch((err) => console.error("[create_checkout] NATS publish error:", (err as Error).message));
    }

    // Untrack completed cart
    try {
      const redis = await getRedisClient();
      await redis.hDel(rk("active:carts"), cartId);
    } catch {
      // Non-critical — TTL will expire
    }

    return {
      success: true,
      paymentMethod: "cash",
      orderId,
      message: orderId
        ? `Pedido realizado com sucesso (${orderId})! Pagamento em dinheiro na entrega.`
        : "Pedido realizado! Pagamento em dinheiro na entrega.",
    };
  }

  // 5. For PIX/card: use extracted Stripe PaymentIntent data
  if (!clientSecret) {
    return {
      success: false,
      paymentMethod,
      message:
        "Não foi possível inicializar o pagamento. Tente novamente ou escolha pagamento em dinheiro.",
    };
  }

  if (paymentMethod === "card") {
    // Track pending checkout so /account/orders can show it before webhook fires
    if (ctx.customerId && paymentIntentId) {
      try {
        const redis = await getRedisClient();
        await redis.hSet(rk(`customer:pending-orders:${ctx.customerId}`), paymentIntentId, JSON.stringify({
          paymentIntentId,
          cartId,
          paymentMethod: "card",
          createdAt: new Date().toISOString(),
        }));
        await redis.expire(rk(`customer:pending-orders:${ctx.customerId}`), 86400 * 7);
      } catch {
        // Non-critical
      }
    }
    return {
      success: true,
      paymentMethod: "card",
      stripeClientSecret: clientSecret,
      message:
        "Sessão de pagamento com cartão iniciada. Use o client_secret para finalizar no frontend.",
    };
  }

  // PIX — confirm with PIX payment method and retrieve QR code
  if (paymentMethod === "pix" && paymentIntentId) {
    if (!extra?.customerName && !extra?.customerEmail) {
      return {
        success: false,
        paymentMethod: "pix",
        message: "Nome e email são obrigatórios para pagamento PIX.",
      };
    }
    return confirmPixAndGetQrCode(paymentIntentId, {
      name: extra?.customerName,
      email: extra?.customerEmail,
      taxId: extra?.customerTaxId,
    }, cartId, ctx.customerId);
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
