// Stripe webhook handler — payment_intent.succeeded / payment_intent.payment_failed / etc.
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
// Reliability (P1-NET-STRIPESYNC) — ACK-THEN-PROCESS-ASYNC, DURABLY:
//   The PIX-succeeded path awaits heavy work (Medusa cart-complete 10s timeout +
//   PI update + capture + NATS + reconcile). Doing that BEFORE returning 200 risked
//   overrunning Stripe's webhook timeout → Stripe retry → reprocessing. The route
//   now: (1) verifies signature, (2) claims the idempotency key, (3) ENQUEUES the
//   event to a DURABLE BullMQ queue (apps/api/src/jobs/stripe-webhook-processor.ts),
//   (4) returns 200 immediately. The worker does the heavy work with durable retry
//   (BullMQ attempts + backoff); a permanent failure is RETAINED in the failed set
//   for replay — a PIX success still reliably completes the order, never lost.
//
// Phase 2: All payment events write to Payment table via PaymentCommandService in
// addition to publishing NATS events. Payment is the source of truth for billing.
// (That logic, plus all event handlers, now lives in the processor.)

import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { getRedisClient, rk } from "@ibatexas/tools";
import { enqueueStripeWebhookEvent, startStripeWebhookProcessor } from "../jobs/stripe-webhook-processor.js";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
}

// ── Route registration ──────────────────────────────────────────────────────

export async function stripeWebhookRoutes(server: FastifyInstance): Promise<void> {
  // Start the durable processor worker here (at route-registration / boot time)
  // so any jobs persisted before a crash are drained immediately on restart —
  // not only when the next webhook arrives. register-workers.ts is a non-owned
  // file we must not edit, so the worker self-registers from this owned file
  // (and again lazily on first enqueue). startStripeWebhookProcessor() is
  // idempotent, so calling it from both places is safe.
  startStripeWebhookProcessor();

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

      // Idempotency — 7 days covers Stripe's 3-day retry window with margin.
      // Claimed BEFORE we return 200 so Stripe retries (and re-deliveries while the
      // job is queued/processing/retrying) dedup on the 418-style duplicate path.
      const redis = await getRedisClient();
      const idempotencyKey = rk(`webhook:processed:${event.id}`);
      const wasSet = await redis.set(idempotencyKey, "1", { EX: 604800, NX: true });
      if (!wasSet) {
        // Already processed (or already enqueued) — return 200 immediately, no side-effects
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      // ACK-THEN-PROCESS-ASYNC: enqueue the heavy work on a DURABLE BullMQ queue
      // and return 200 fast so we never overrun Stripe's webhook timeout. The
      // worker (stripe-webhook-processor) does Medusa-complete + capture + NATS +
      // reconcile with durable retry.
      try {
        await enqueueStripeWebhookEvent(event, startMs);
      } catch (err) {
        // Enqueue itself failed (e.g. Redis/BullMQ unavailable) — nothing is queued,
        // so the order would be stranded behind a claimed key. Downgrade the key to
        // 5 minutes so Stripe's RETRY re-delivers and can re-enqueue once Redis
        // recovers, then return 500. (Same downgrade rationale as the old sync error
        // path: short enough to re-open the window soon, long enough to avoid an
        // immediate duplicate before recovery.)
        server.log.error(
          { event_id: event.id, error: String(err) },
          "Stripe webhook enqueue failed — downgrading idempotency key for Stripe retry",
        );
        await redis.expire(idempotencyKey, 300);
        return reply.code(500).send({ error: "Failed to enqueue webhook for processing" });
      }

      server.log.info(
        { event_id: event.id, type: event.type, enqueue_ms: Date.now() - startMs },
        "Stripe webhook accepted and enqueued",
      );
      return reply.code(200).send({ ok: true });
    },
  );
  }); // end stripeWebhookPlugin register
}
