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

import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { getRedisClient, rk, medusaAdmin } from "@ibatexas/tools";
import { createOrderService } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
}

async function handlePaymentSucceeded(
  event: Stripe.Event,
  startMs: number,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const processingMs = Date.now() - startMs;

  logger.info(
    { event_id: event.id, type: event.type, processing_ms: processingMs },
    "Stripe webhook received",
  );

  const orderId = paymentIntent.metadata?.["medusaOrderId"];
  if (!orderId) {
    logger.warn({ event_id: event.id }, "payment_intent.succeeded missing medusaOrderId metadata");
    return;
  }

  const svc = createOrderService(medusaAdmin);
  const result = await svc.capturePayment(orderId, paymentIntent.id);

  if (!result) {
    logger.info({ event_id: event.id, order_id: orderId }, "Order already processed — no-op");
    return;
  }

  await publishNatsEvent("order.placed", {
    eventType: "order.placed",
    orderId,
    customerId: result.customerId,
    items: result.items,
    stripePaymentIntentId: paymentIntent.id,
  });

  logger.info(
    { event_id: event.id, order_id: orderId, processing_ms: Date.now() - startMs },
    "payment_intent.succeeded processed",
  );
}

async function handleChargeRefunded(
  event: Stripe.Event,
  startMs: number,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const orderId = charge.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  logger.info(
    { event_id: event.id, type: event.type, order_id: orderId, processing_ms: processingMs },
    "Stripe charge.refunded received",
  );

  if (!orderId) {
    logger.warn({ event_id: event.id }, "charge.refunded missing medusaOrderId metadata");
    return;
  }

  // AUDIT-FIX: EVT-F04 — order.refunded has no subscriber yet. Keeping for future refund intelligence.
  // TODO: [AUDIT-REVIEW] Add subscriber for order.refunded to update customer profile and analytics
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
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const orderId = dispute.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  logger.warn(
    { event_id: event.id, type: event.type, dispute_id: dispute.id, order_id: orderId, processing_ms: processingMs },
    "Stripe charge.dispute.created received — dispute opened",
  );

  // AUDIT-FIX: EVT-F04 — order.disputed has no subscriber yet. Keeping for future dispute alerting.
  // TODO: [AUDIT-REVIEW] Add subscriber for order.disputed to trigger alerts and update profile
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
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const orderId = paymentIntent.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  logger.info(
    { event_id: event.id, type: event.type, order_id: orderId, processing_ms: processingMs },
    "Stripe payment_intent.canceled received",
  );

  if (!orderId) {
    logger.warn({ event_id: event.id }, "payment_intent.canceled missing medusaOrderId metadata");
    return;
  }

  // AUDIT-FIX: EVT-F04 — order.canceled has no subscriber yet. Keeping for future cancellation analytics.
  // TODO: [AUDIT-REVIEW] Add subscriber for order.canceled to update customer profile
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

export async function stripeWebhookRoutes(server: FastifyInstance): Promise<void> {
  // Register with raw body content type so we get the Buffer
  server.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: 1_048_576 },
    (req, body, done) => {
      // Only intercept webhook path — allow normal JSON parsing everywhere else
      if (req.url === "/api/webhooks/stripe") {
        done(null, body);
      } else {
        // Let other routes parse JSON normally
        try {
          done(null, JSON.parse((body as Buffer).toString("utf-8")));
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    },
  );

  server.post(
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
            const paymentIntent = event.data.object;
            const orderId = paymentIntent.metadata?.["medusaOrderId"];

            server.log.info(
              { event_id: event.id, type: event.type, processing_ms: Date.now() - startMs },
              "Stripe webhook received",
            );

            if (orderId) {
              await publishNatsEvent("order.payment_failed", {
                eventType: "order.payment_failed",
                orderId,
                stripePaymentIntentId: paymentIntent.id,
                lastPaymentError: paymentIntent.last_payment_error?.message,
              });
            }
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
        // Remove idempotency key so next retry can reprocess
        await redis.del(idempotencyKey);
        return reply.code(500).send({ error: "Internal processing error" });
      }

      return reply.code(200).send({ ok: true });
    },
  );
}
