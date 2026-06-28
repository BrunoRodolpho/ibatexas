// create_checkout tool — initialize payment session and return checkout data
//
// For PIX: returns Stripe PIX QR code from payment intent (confirmed via Stripe webhook)
// For card: returns Stripe payment intent client secret
// For cash: completes directly and publishes order.placed
//
// IMPORTANT: PIX and card orders are only confirmed via Stripe webhook —
// never by client polling alone to avoid stuck-pending orders.

import type Stripe from "stripe";
import { CreateCheckoutInputSchema, NonRetryableError, formatOrderId, type CreateCheckoutInput, type AgentContext } from "@ibatexas/types";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { getAuditSink } from "@ibatexas/audit-sink";
import { reaisToCentavos } from "../medusa/client.js";
import { loadSchedule } from "../cache/schedule-cache.js";
import { getAndConsumeWelcomeCredit } from "../intelligence/welcome-credit.js";
import { getMealPeriodFromSchedule } from "../schedule/schedule-helpers.js";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { stripeAdjudicated } from "../stripe/adjudicated.js";
import { medusaStoreAdjudicated } from "../medusa/store-adjudicated.js";
import { medusaStoreFetch } from "./_shared.js";

export interface CreateCheckoutOutput {
  success: boolean;
  paymentMethod: string;
  // PIX
  pixQrCode?: string;
  pixCopyPaste?: string;
  pixExpiresAt?: string;
  // Card
  stripeClientSecret?: string;
  // Card — the Stripe PaymentIntent id (e.g. `pi_…`). The order itself is
  // created LATER by the Stripe webhook, so a card checkout has no `orderId`
  // yet; the guest tracks via `/pedido/<paymentIntentId>`. Surfaced so the
  // route can mint a per-order access token bound to this id (R0a guest-card).
  paymentIntentId?: string;
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
    const returnUrl = process.env.RESTAURANT_SITE_URL ?? process.env.NEXT_PUBLIC_URL ?? "https://ibatexas.com.br";

    // LGPD: never log raw PII (name) outside the audit ledger. Log presence
    // booleans only, mirroring the email masking already used here.
    console.warn("[create_checkout] Confirming PI %s with PIX (name_present=%s email_present=%s)",
      paymentIntentId, customer.name ? "true" : "false", customer.email ? "true" : "false");

    // PIX requires: name, email, tax_id (CPF/CNPJ)
    // WhatsApp users don't provide email or CPF — use restaurant defaults
    const taxId = customer.taxId || process.env.PIX_FALLBACK_TAX_ID;

    // PIX confirm — kernel-adjudicated egress.
    const confirmed = await stripeAdjudicated.paymentIntents.confirm(
      paymentIntentId,
      {
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
      },
      {
        sourceSubject: `tool:create-checkout:confirmPixAndGetQrCode:${customerId ?? "anon"}`,
        idempotencyKey: `pix-confirm:${paymentIntentId}`,
        auditSink: getAuditSink(),
      },
    ) as Stripe.PaymentIntent & {
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
      // PI metadata update — kernel-adjudicated egress.
      await stripeAdjudicated.paymentIntents.update(
        paymentIntentId,
        { metadata: { cartId } },
        {
          sourceSubject: `tool:create-checkout:setCartIdMetadata:${customerId ?? "anon"}`,
          idempotencyKey: `pi-meta:cart:${paymentIntentId}:${cartId}`,
          auditSink: getAuditSink(),
        },
      );
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

// ── create_checkout helpers ─────────────────────────────────────────────
// Module-local helpers keep `createCheckout` flat: each owns one adjudicated
// egress / branch so the orchestrator stays readable and below the cognitive
// complexity threshold. Behavior is identical to the previous inline form.

type CartLineItem = {
  variant_id: string;
  title?: string;
  quantity: number;
  unit_price: number;
  variant?: { product_id?: string; title?: string };
};

async function applyWelcomeCredit(cartId: string, ctx: AgentContext): Promise<void> {
  if (!ctx.customerId) return;
  try {
    const welcomeCode = await getAndConsumeWelcomeCredit(ctx.customerId);
    if (welcomeCode) {
      await medusaStoreAdjudicated.carts.promotions.add(
        { cartId, promoCodes: [welcomeCode] },
        {
          sourceSubject: "cart:create-checkout:apply-promotion",
          actorPrincipal: "llm",
          auditSink: getAuditSink(),
          ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        },
      );
      console.warn(`[checkout] Welcome credit ${welcomeCode} applied for customer ${ctx.customerId}`);
    }
  } catch (err) {
    // Medusa rejected the code (expired, already used, or not configured) — continue without discount
    console.warn(`[checkout] Welcome credit application failed for customer ${ctx.customerId}: ${(err as Error).message}`);
  }
}

async function buildCheckoutMetadata(
  paymentMethod: string,
  tipInCentavos: number | undefined,
  deliveryCep: string | undefined,
  ctx: AgentContext,
): Promise<Record<string, string>> {
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
  return metadata;
}

async function updateCartMetadata(
  cartId: string,
  metadata: Record<string, string>,
  ctx: AgentContext,
): Promise<void> {
  await medusaStoreAdjudicated.carts.update(
    { cartId, body: { metadata } },
    {
      sourceSubject: "cart:create-checkout:update-email",
      actorPrincipal: "llm",
      auditSink: getAuditSink(),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    },
  );
}

async function resolvePaymentCollectionId(
  cartId: string,
  existingId: string | undefined,
  ctx: AgentContext,
): Promise<string | undefined> {
  if (existingId) return existingId;
  const pcData = await medusaStoreAdjudicated.paymentCollections.create(
    { cartId },
    {
      sourceSubject: "cart:create-checkout:create-payment-collection",
      actorPrincipal: "llm",
      auditSink: getAuditSink(),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    },
  ) as { payment_collection?: { id: string } };
  return pcData.payment_collection?.id;
}

async function resolveProviderId(paymentMethod: string, cart: unknown): Promise<string> {
  if (paymentMethod === "cash") {
    return "pp_system_default";
  }
  // Query registered providers and find the Stripe one
  const cartRegion = cart as { region_id?: string } | undefined;
  const regionParam = cartRegion?.region_id ? `?region_id=${cartRegion.region_id}` : "";
  try {
    const providersData = await medusaStoreFetch(`/store/payment-providers${regionParam}`) as {
      payment_providers?: Array<{ id: string; is_enabled?: boolean }>;
    };
    const stripeProvider = providersData.payment_providers?.find(
      (p) => p.id.includes("stripe"),
    );
    const providerId = stripeProvider?.id ?? "pp_stripe_stripe";
    console.warn("[create_checkout] Resolved Stripe provider_id: %s", providerId);
    return providerId;
  } catch {
    // Fallback to common default
    const providerId = "pp_stripe_stripe";
    console.warn("[create_checkout] Could not query payment providers — using default: %s", providerId);
    return providerId;
  }
}

async function createPaymentSession(
  paymentCollectionId: string,
  providerId: string,
  ctx: AgentContext,
): Promise<unknown> {
  return medusaStoreAdjudicated.paymentCollections.paymentSessions.create(
    { paymentCollectionId, providerId },
    {
      sourceSubject: "cart:create-checkout:create-payment-session",
      actorPrincipal: "llm",
      auditSink: getAuditSink(),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    },
  );
}

function extractStripeSessionData(rawSessionData: unknown): {
  clientSecret?: string;
  paymentIntentId?: string;
} {
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

  return { clientSecret, paymentIntentId };
}

async function completeCashOrder(
  cartId: string,
  items: CartLineItem[] | undefined,
  metadata: Record<string, string>,
  tipInCentavos: number | undefined,
  ctx: AgentContext,
): Promise<CreateCheckoutOutput> {
  // Extract cart items for the order.placed event
  const cartItems = (items ?? []).map((item) => ({
    productId: item.variant?.product_id ?? "",
    variantId: item.variant_id,
    title: item.title ?? item.variant?.title ?? "",
    quantity: item.quantity,
    priceInCentavos: reaisToCentavos(item.unit_price),
  }));

  // Complete cart directly for cash payment
  const completedData = await medusaStoreAdjudicated.carts.complete(
    { cartId },
    {
      sourceSubject: "cart:create-checkout:complete",
      actorPrincipal: "llm",
      auditSink: getAuditSink(),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    },
  ) as { type?: string; order?: { id: string; display_id?: number; total?: number; subtotal?: number; shipping_total?: number } };

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

async function trackPendingCardCheckout(
  customerId: string | undefined,
  paymentIntentId: string | undefined,
  cartId: string,
): Promise<void> {
  // Track pending checkout so /account/orders can show it before webhook fires
  if (!customerId || !paymentIntentId) return;
  try {
    const redis = await getRedisClient();
    await redis.hSet(rk(`customer:pending-orders:${customerId}`), paymentIntentId, JSON.stringify({
      paymentIntentId,
      cartId,
      paymentMethod: "card",
      createdAt: new Date().toISOString(),
    }));
    await redis.expire(rk(`customer:pending-orders:${customerId}`), 86400 * 7);
  } catch {
    // Non-critical
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
  await applyWelcomeCredit(cartId, ctx);

  // 1. Update cart metadata with tip and delivery CEP
  const metadata = await buildCheckoutMetadata(paymentMethod, tipInCentavos, deliveryCep, ctx);
  await updateCartMetadata(cartId, metadata, ctx);

  // 2. Get or create payment collection (Medusa v2 flow)
  const cartForPC = await medusaStoreFetch(`/store/carts/${cartId}`) as {
    cart?: {
      payment_collection?: { id: string };
      items?: CartLineItem[];
    };
  };
  const paymentCollectionId = await resolvePaymentCollectionId(
    cartId,
    cartForPC.cart?.payment_collection?.id,
    ctx,
  );

  if (!paymentCollectionId) {
    return {
      success: false,
      paymentMethod,
      message: "Não foi possível inicializar o pagamento. Tente novamente.",
    };
  }

  // 3. Resolve the payment provider ID dynamically from Medusa
  //    (avoids hardcoding — the ID format varies by Medusa version + config)
  const providerId = await resolveProviderId(paymentMethod, cartForPC.cart);

  // 4. Initialize payment session on the payment collection
  const rawSessionData = await createPaymentSession(paymentCollectionId, providerId, ctx);

  // Debug: log the response shape to diagnose Stripe data extraction
  console.warn("[create_checkout] payment session response: %s", JSON.stringify(rawSessionData).slice(0, 1500));

  const { clientSecret, paymentIntentId } = extractStripeSessionData(rawSessionData);

  if (paymentMethod === "cash") {
    return completeCashOrder(cartId, cartForPC.cart?.items, metadata, tipInCentavos, ctx);
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
    await trackPendingCardCheckout(ctx.customerId, paymentIntentId, cartId);
    return {
      success: true,
      paymentMethod: "card",
      stripeClientSecret: clientSecret,
      // R0a guest-card: surface the PaymentIntent id so the route can mint a
      // per-order access token bound to it (the guest tracks via
      // `/pedido/<paymentIntentId>` until the webhook creates the order).
      paymentIntentId,
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
