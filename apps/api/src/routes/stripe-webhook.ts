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
import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { medusaAdmin } from "./admin/_shared.js";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
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
            const paymentIntent = event.data.object as Stripe.PaymentIntent;
            const processingMs = Date.now() - startMs;

            server.log.info(
              { event_id: event.id, type: event.type, processing_ms: processingMs },
              "Stripe webhook received",
            );

            // Find Medusa order by paymentIntentId metadata
            const orderId = paymentIntent.metadata?.["medusaOrderId"];
            if (!orderId) {
              server.log.warn({ event_id: event.id }, "payment_intent.succeeded missing medusaOrderId metadata");
              break;
            }

            // DB-layer double defense: fetch order and assert it is still pending
            let order: {
              status: string;
              customer_id?: string;
              metadata?: Record<string, string>;
              items?: Array<{ variant_id: string; quantity: number; unit_price: number; title: string; product_id?: string }>;
            };
            try {
              const data = await medusaAdmin(`/admin/orders/${orderId}?expand=items`) as { order: typeof order };
              order = data.order;
            } catch (err) {
              server.log.error({ event_id: event.id, order_id: orderId, error: String(err) }, "Failed to fetch Medusa order");
              throw err; // rethrow so Redis key is NOT set (allow retry)
            }

            // Guard 1: order already captured or cancelled
            if (order.status !== "pending") {
              server.log.info({ event_id: event.id, order_id: orderId, status: order.status }, "Order already processed — no-op");
              break;
            }

            // Guard 2: stripePaymentIntentId already stored
            if (order.metadata?.["stripePaymentIntentId"]) {
              server.log.info({ event_id: event.id, order_id: orderId }, "stripePaymentIntentId already set — no-op");
              break;
            }

            // Capture payment via Medusa workflow
            await medusaAdmin(`/admin/orders/${orderId}/capture-payment`, { method: "POST" });

            // Store stripePaymentIntentId on order metadata
            await medusaAdmin(`/admin/orders/${orderId}`, {
              method: "POST",
              body: JSON.stringify({ metadata: { stripePaymentIntentId: paymentIntent.id } }),
            });

            // Publish order.placed NATS event with items for intelligence tracking
            const orderItems = (order.items ?? []).map((item) => ({
              productId: item.product_id ?? item.variant_id,
              variantId: item.variant_id,
              quantity: item.quantity,
              priceInCentavos: item.unit_price ?? 0,
            }));
            const customerId = order.customer_id ?? order.metadata?.["customerId"];

            await publishNatsEvent("ibatexas.order.placed", {
              eventType: "order.placed",
              orderId,
              customerId,
              items: orderItems,
              stripePaymentIntentId: paymentIntent.id,
            });

            server.log.info(
              { event_id: event.id, order_id: orderId, processing_ms: Date.now() - startMs },
              "payment_intent.succeeded processed",
            );
            break;
          }

          case "payment_intent.payment_failed": {
            const paymentIntent = event.data.object as Stripe.PaymentIntent;
            const orderId = paymentIntent.metadata?.["medusaOrderId"];

            server.log.info(
              { event_id: event.id, type: event.type, processing_ms: Date.now() - startMs },
              "Stripe webhook received",
            );

            if (orderId) {
              await publishNatsEvent("ibatexas.order.payment_failed", {
                eventType: "order.payment_failed",
                orderId,
                stripePaymentIntentId: paymentIntent.id,
                lastPaymentError: paymentIntent.last_payment_error?.message,
              });
            }
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
