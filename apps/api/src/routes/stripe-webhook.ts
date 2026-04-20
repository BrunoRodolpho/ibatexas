// Stripe webhook handler — payment_intent.succeeded / payment_intent.payment_failed
//
// IMPORTANT: This plugin must be registered BEFORE Fastify's JSON body parser
// so we can capture the raw Buffer needed by stripe.webhooks.constructEvent.
//
// Security:
//   - Signature verified via stripe.webhooks.constructEvent (300s tolerance built-in)
//   - Replay attack prevention: timestamp checked by Stripe's SDK
// Idempotency:
//   - SET rk('webhook:processed:{event.id}') 1 EX 604800 NX (7 days)
//   - Duplicate events return 200 immediately with no side-effects
//
// Phase 2: All payment events now write to Payment table via PaymentCommandService
// in addition to publishing NATS events. Payment is the source of truth for billing.

import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { getRedisClient, rk, medusaAdmin, medusaStore, withLock } from "@ibatexas/tools";
import { createOrderService, createPaymentCommandService, createPaymentQueryService, createOrderEventLogService } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  formatOrderId,
  PaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import { markPixPaid } from "../jobs/pix-expiry-monitor.js";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
}

type WebhookLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

// ── Reconcile payment status from Stripe event ──────────────────────────────

async function reconcilePaymentFromStripe(
  stripePaymentIntentId: string,
  newStatus: (typeof PaymentStatus)[keyof typeof PaymentStatus],
  event: Stripe.Event,
  logger: WebhookLogger,
): Promise<void> {
  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService(logger);

  const payment = await paymentQuerySvc.getByStripePaymentIntentId(stripePaymentIntentId);
  if (!payment) {
    // Payment row may not exist yet (e.g. PIX cart completion creates it later)
    logger.info(
      { event_id: event.id, stripe_pi: stripePaymentIntentId },
      "[stripe-webhook] No Payment row found for PI — skipping reconciliation",
    );
    return;
  }

  const result = await withLock(`payment:${payment.id}`, async () => {
    return paymentCmdSvc.reconcileFromWebhook(payment.id, {
      newStatus,
      stripeEventId: event.id,
      stripeEventTimestamp: new Date(event.created * 1000),
      expectedOrderId: payment.orderId,
    });
  }, 30);

  if (result === null) {
    logger.info(
      { event_id: event.id, paymentId: payment.id },
      "[stripe-webhook] Payment reconciliation skipped (lock, terminal, or already at target)",
    );
    return;
  }

  // Publish payment.status_changed
  await publishNatsEvent("payment.status_changed", {
    eventType: "payment.status_changed",
    orderId: payment.orderId,
    paymentId: payment.id,
    previousStatus: payment.status,
    newStatus,
    method: payment.method,
    version: result.version,
    stripeEventId: event.id,
    timestamp: new Date().toISOString(),
  } satisfies PaymentStatusChangedEvent & { eventType: string });

  // Audit trail
  const eventLogSvc = createOrderEventLogService(logger);
  await eventLogSvc.append({
    orderId: payment.orderId,
    eventType: "payment.status_changed",
    discriminator: `${payment.id}:${newStatus}:stripe:${event.id}`,
    payload: { paymentId: payment.id, previousStatus: payment.status, newStatus, stripeEventId: event.id },
    timestamp: new Date(),
  }).catch(() => {});

  logger.info(
    { event_id: event.id, paymentId: payment.id, from: payment.status, to: newStatus },
    "[stripe-webhook] Payment reconciled",
  );
}

// ── Event handlers ──────────────────────────────────────────────────────────

async function handlePaymentSucceeded(
  event: Stripe.Event,
  startMs: number,
  logger: WebhookLogger,
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const processingMs = Date.now() - startMs;

  logger.info(
    { event_id: event.id, type: event.type, processing_ms: processingMs },
    "Stripe webhook received",
  );

  let orderId: string | undefined = paymentIntent.metadata?.["medusaOrderId"];

  // PIX flow: cart was not completed at checkout time — complete it now
  // that payment has succeeded, creating the Medusa order.
  const cartId = paymentIntent.metadata?.["cartId"];
  if (!orderId && cartId) {
    try {
      const completedData = await medusaStore(`/store/carts/${cartId}/complete`, {
        method: "POST",
        body: JSON.stringify({}),
      }) as { type?: string; order?: { id: string; display_id?: number } };

      orderId = completedData.order?.display_id
        ? formatOrderId(completedData.order.display_id)
        : completedData.order?.id;

      if (orderId) {
        // Persist orderId back to the PaymentIntent for future reference
        const stripe = getStripe();
        await stripe.paymentIntents.update(paymentIntent.id, {
          metadata: { ...paymentIntent.metadata, medusaOrderId: orderId },
        });
        logger.info({ event_id: event.id, cart_id: cartId, order_id: orderId }, "PIX: cart completed, order created");
      }
    } catch (err) {
      logger.error({ event_id: event.id, cart_id: cartId, error: String(err) }, "PIX: failed to complete cart");
    }
  }

  if (!orderId) {
    logger.warn({ event_id: event.id }, "payment_intent.succeeded missing medusaOrderId metadata");
    return;
  }

  const svc = createOrderService(medusaAdmin);
  const result = await svc.capturePayment(orderId, paymentIntent.id, {
    amountInCentavos: paymentIntent.amount,
  });

  if (!result) {
    logger.info({ event_id: event.id, order_id: orderId }, "Order already processed — no-op");
    // Still reconcile payment status even if order was already processed
    await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.PAID, event, logger);
    return;
  }

  await publishNatsEvent("order.placed", {
    eventType: "order.placed",
    orderId,
    customerId: result.customerId,
    displayId: result.displayId,
    customerEmail: result.customerEmail,
    customerName: result.customerName,
    customerPhone: result.customerPhone,
    totalInCentavos: result.totalInCentavos,
    subtotalInCentavos: result.subtotalInCentavos,
    shippingInCentavos: result.shippingInCentavos,
    items: result.items,
    stripePaymentIntentId: paymentIntent.id,
    paymentMethod: (result.paymentMethod as "pix" | "card" | "cash") ?? "pix",
    paymentStatus: "captured",
    deliveryType: result.deliveryType,
    tipInCentavos: result.tipInCentavos,
    version: 1,
  });

  // Reconcile payment status → paid
  await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.PAID, event, logger);

  // Clean up pending-order entry now that the Medusa order exists
  const domainCustomerId = paymentIntent.metadata?.["customerId"];
  if (domainCustomerId) {
    try {
      const redis = await getRedisClient();
      await redis.hDel(rk(`customer:pending-orders:${domainCustomerId}`), paymentIntent.id);
    } catch {
      // Non-critical cleanup
    }
  }

  // Mark PIX as paid so expiry monitor skips reminders for this order
  await markPixPaid(orderId).catch((err) => {
    logger.warn({ error: String(err), order_id: orderId }, "[stripe.pix.mark_paid_failed]");
  });

  logger.info(
    { event_id: event.id, order_id: orderId, processing_ms: Date.now() - startMs },
    "payment_intent.succeeded processed",
  );
}

async function handlePaymentFailed(
  event: Stripe.Event,
  startMs: number,
  logger: WebhookLogger,
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const orderId = paymentIntent.metadata?.["medusaOrderId"];

  logger.info(
    { event_id: event.id, type: event.type, processing_ms: Date.now() - startMs },
    "Stripe webhook received",
  );

  // Reconcile payment status → payment_failed
  await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.PAYMENT_FAILED, event, logger);

  if (orderId) {
    await publishNatsEvent("order.payment_failed", {
      eventType: "order.payment_failed",
      orderId,
      stripePaymentIntentId: paymentIntent.id,
      lastPaymentError: paymentIntent.last_payment_error?.message,
    });
  }
}

async function handleChargeRefunded(
  event: Stripe.Event,
  startMs: number,
  logger: WebhookLogger,
): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const orderId = charge.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  logger.info(
    { event_id: event.id, type: event.type, order_id: orderId, processing_ms: processingMs },
    "Stripe charge.refunded received",
  );

  // Determine if full or partial refund
  const isFullRefund = charge.amount_refunded >= charge.amount;
  const targetStatus = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

  // Look up payment by PI ID (charge.payment_intent)
  const piId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id;
  if (piId) {
    await reconcilePaymentFromStripe(piId, targetStatus, event, logger);
  }

  if (!orderId) {
    logger.warn({ event_id: event.id }, "charge.refunded missing medusaOrderId metadata");
    return;
  }

  await publishNatsEvent("order.refunded", {
    eventType: "order.refunded",
    orderId,
    chargeId: charge.id,
    amountRefunded: charge.amount_refunded,
  });

  logger.info(
    { event_id: event.id, order_id: orderId, processing_ms: Date.now() - startMs },
    "charge.refunded processed",
  );
}

async function handleChargeDisputeCreated(
  event: Stripe.Event,
  startMs: number,
  logger: WebhookLogger,
): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const orderId = dispute.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  logger.warn(
    { event_id: event.id, type: event.type, dispute_id: dispute.id, order_id: orderId, processing_ms: processingMs },
    "Stripe charge.dispute.created received — dispute opened",
  );

  // Reconcile payment → disputed
  const piId = typeof dispute.payment_intent === "string"
    ? dispute.payment_intent
    : dispute.payment_intent?.id;
  if (piId) {
    await reconcilePaymentFromStripe(piId, PaymentStatus.DISPUTED, event, logger);
  }

  await publishNatsEvent("order.disputed", {
    eventType: "order.disputed",
    orderId: orderId ?? null,
    disputeId: dispute.id,
    amount: dispute.amount,
    reason: dispute.reason,
  });

  logger.warn(
    { event_id: event.id, dispute_id: dispute.id, processing_ms: Date.now() - startMs },
    "charge.dispute.created processed",
  );
}

async function handlePaymentIntentCanceled(
  event: Stripe.Event,
  startMs: number,
  logger: WebhookLogger,
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const orderId = paymentIntent.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  logger.info(
    { event_id: event.id, type: event.type, order_id: orderId, processing_ms: processingMs },
    "Stripe payment_intent.canceled received",
  );

  // Reconcile payment → canceled
  await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.CANCELED, event, logger);

  if (!orderId) {
    logger.warn({ event_id: event.id }, "payment_intent.canceled missing medusaOrderId metadata");
    return;
  }

  await publishNatsEvent("order.canceled", {
    eventType: "order.canceled",
    orderId,
    stripePaymentIntentId: paymentIntent.id,
    cancellationReason: paymentIntent.cancellation_reason,
  });

  logger.info(
    { event_id: event.id, order_id: orderId, processing_ms: Date.now() - startMs },
    "payment_intent.canceled processed",
  );
}

// ── Route registration ──────────────────────────────────────────────────────

export async function stripeWebhookRoutes(server: FastifyInstance): Promise<void> {
  // Scope raw body parser to this route only (Fastify encapsulated plugin)
  await server.register(async function stripeWebhookPlugin(scoped) {
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 1_048_576 },
      (_req, body, done) => {
        done(null, body); // pass raw Buffer for Stripe signature verification
      },
    );

    scoped.post(
    "/api/webhooks/stripe",
    {
      config: { rawBody: true },
      schema: {
        tags: ["webhooks"],
        summary: "Stripe payment webhook",
      },
    },
    async (request, reply) => {
      const sig = request.headers["stripe-signature"];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret) {
        server.log.error({ url: request.url }, "STRIPE_WEBHOOK_SECRET not configured");
        return reply.code(500).send({ error: "Webhook secret not configured" });
      }

      if (typeof sig !== "string") {
        server.log.warn({ ip: request.ip }, "Stripe webhook missing signature");
        return reply.code(400).send({ error: "Missing stripe-signature header" });
      }

      let event: Stripe.Event;
      const stripe = getStripe();
      const startMs = Date.now();

      try {
        // constructEvent validates signature AND rejects timestamps older than 300s (default)
        event = stripe.webhooks.constructEvent(request.body as Buffer, sig, webhookSecret);
      } catch (err) {
        server.log.warn({ ip: request.ip, error: String(err), action: "stripe_signature_failure" });
        return reply.code(400).send({ error: "Webhook signature verification failed" });
      }

      // Idempotency — 7 days covers Stripe's 3-day retry window with margin
      const redis = await getRedisClient();
      const idempotencyKey = rk(`webhook:processed:${event.id}`);
      const wasSet = await redis.set(idempotencyKey, "1", { EX: 604800, NX: true });
      if (!wasSet) {
        // Already processed — return 200 immediately, no side-effects
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      try {
        switch (event.type) {
          case "payment_intent.succeeded": {
            await handlePaymentSucceeded(event, startMs, server.log);
            break;
          }

          case "payment_intent.payment_failed": {
            await handlePaymentFailed(event, startMs, server.log);
            break;
          }

          case "charge.refunded": {
            await handleChargeRefunded(event, startMs, server.log);
            break;
          }

          case "charge.dispute.created": {
            await handleChargeDisputeCreated(event, startMs, server.log);
            break;
          }

          case "payment_intent.canceled": {
            await handlePaymentIntentCanceled(event, startMs, server.log);
            break;
          }

          default:
            server.log.info({ event_id: event.id, type: event.type }, "Unhandled Stripe event type — ignoring");
        }
      } catch (err) {
        server.log.error({ event_id: event.id, error: String(err) }, "Stripe webhook processing error");
        // Keep the key alive for 5 minutes instead of deleting it. Deleting immediately
        // would allow Stripe's retry to reprocess before a partial success (e.g. NATS
        // published but Medusa call failed) has had time to roll back, causing duplicate
        // order.placed events. The 5-min TTL closes that window while still letting
        // Stripe retry succeed once the transient failure has recovered.
        await redis.expire(idempotencyKey, 300);
        return reply.code(500).send({ error: "Internal processing error" });
      }

      return reply.code(200).send({ ok: true });
    },
  );
  }); // end stripeWebhookPlugin register
}
