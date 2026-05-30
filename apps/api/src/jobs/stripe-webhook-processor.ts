// Stripe webhook processor — DURABLE async handler for Stripe payment events.
//
// WHY THIS EXISTS (P1-NET-STRIPESYNC):
// The PIX-succeeded path awaits heavy synchronous work — Medusa cart-complete
// (10s timeout) + PI metadata update + capturePayment + NATS publish + reconcile
// — and previously did so BEFORE the route returned 200 to Stripe. A slow-but-
// successful run could overrun Stripe's webhook timeout, triggering a Stripe
// RETRY and reprocessing (made worse by the deliberate 5-min idempotency-key
// downgrade-on-error which re-opens the dedup window).
//
// FIX: the route now verifies the signature, claims the idempotency key, ENQUEUES
// the raw event here, and returns 200 immediately. This worker does the heavy work
// asynchronously on a DURABLE path:
//   - BullMQ gives durable retry: jobs are persisted in Redis; a crash/failure
//     RETRIES (attempts + exponential backoff) rather than losing order-completion.
//   - On permanent failure (attempts exhausted) the job is RETAINED in the failed
//     set (removeOnFail: { count }) — observable + manually replayable, never
//     silently dropped. This is the key invariant: a PIX success still reliably
//     completes the order.
//
// The per-handler logic below is MOVED VERBATIM from stripe-webhook.ts and
// preserves all cycle-2 fixes: idempotency, the per-order capture lock
// (double-capture protection P0-PAY-2), capturePayment's centavos amount
// (off-by-100), and Payment-table reconciliation.

import * as Sentry from "@sentry/node";
import Stripe from "stripe";
import { getRedisClient, rk, medusaAdmin, medusaStore, withLock } from "@ibatexas/tools";
import { createOrderService, createPaymentCommandService, createPaymentQueryService, createOrderEventLogService } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  formatOrderId,
  PaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import type { PaymentStatusReconcilePayload } from "@ibatexas/pack-payments";
import type { Queue, Worker } from "bullmq";
import logger from "../lib/logger.js";
import { createQueue, createWorker, type Job } from "./queue.js";
import { markPixPaid } from "./pix-expiry-monitor.js";
import { adjudicateSystemMutation } from "../routes/__shared__/customer-intent-gateway.js";

const QUEUE_NAME = "stripe-webhook";

// Durable retry: attempts + exponential backoff. A transient failure (Medusa/NATS
// blip) is retried before the job lands in the failed set. process.env per Hard
// Rule #3.
const STRIPE_WEBHOOK_JOB_ATTEMPTS = Number.parseInt(
  process.env.STRIPE_WEBHOOK_JOB_ATTEMPTS || "5",
  10,
);
const STRIPE_WEBHOOK_JOB_BACKOFF_MS = Number.parseInt(
  process.env.STRIPE_WEBHOOK_JOB_BACKOFF_MS || "5000",
  10,
);

type WebhookLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/**
 * Minimal payload enqueued by the route. We carry the full Stripe.Event because
 * the handlers below read several fields off event.data.object + event.created;
 * the event is already signature-verified by the route before enqueue.
 */
export interface StripeWebhookJobData {
  event: Stripe.Event;
  /** epoch ms when the route received the event — kept for processing_ms logging parity */
  receivedAtMs: number;
}

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
}

// ── Reconcile payment status from Stripe event ──────────────────────────────

async function reconcilePaymentFromStripe(
  stripePaymentIntentId: string,
  newStatus: (typeof PaymentStatus)[keyof typeof PaymentStatus],
  event: Stripe.Event,
  log: WebhookLogger,
): Promise<void> {
  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService(log);

  const payment = await paymentQuerySvc.getByStripePaymentIntentId(stripePaymentIntentId);
  if (!payment) {
    // Payment row may not exist yet (e.g. PIX cart completion creates it later)
    log.info(
      { event_id: event.id, stripe_pi: stripePaymentIntentId },
      "[stripe-webhook] No Payment row found for PI — skipping reconciliation",
    );
    return;
  }

  // RC-A1 Phase B (system path) — gate the payment-projection reconcile through the
  // conductor as a SYSTEM mutation (principal:"system", taint:"TRUSTED"). All five
  // webhook handlers funnel their mutation through here, so this single seam covers
  // succeeded/failed/refunded/dispute/canceled uniformly via payment.status.reconcile
  // — the pack kind purpose-built for "reconciliation from a Stripe webhook", which
  // is EXECUTE-clean and EXEMPT from the terminal-transition block (correct for
  // out-of-order Stripe events). Byte-equivalent legacy path while inert (the
  // withLock + reconcileFromWebhook closure runs unconditionally). Only the
  // reconcile is gated: capturePayment / Medusa cart-complete / order.placed in
  // handlePaymentSucceeded stay as order-creation side effects (consistent with the
  // HTTP cutover leaving order.placed ungated).
  const outcome = await adjudicateSystemMutation({
    kind: "payment.status.reconcile",
    payload: {
      paymentId: payment.id,
      newStatus,
      stripeEventId: event.id,
      stripeEventTimestamp: new Date(event.created * 1000).toISOString(),
      expectedOrderId: payment.orderId,
    } satisfies PaymentStatusReconcilePayload,
    sessionId: `stripe:${event.id}`,
    // PaymentState for payment.status.reconcile: requirePaymentExists (exists:true —
    // payment was just fetched above) + taint gate (systemOnlyKind → TRUSTED ✓);
    // executeAll → EXECUTE. Exempt from refuseTerminalTransition by design.
    state: { ctx: { actor: { principal: "system" }, exists: true } },
    legacy: () =>
      withLock(`payment:${payment.id}`, async () => {
        return paymentCmdSvc.reconcileFromWebhook(payment.id, {
          newStatus,
          stripeEventId: event.id,
          stripeEventTimestamp: new Date(event.created * 1000),
          expectedOrderId: payment.orderId,
        });
      }, 30),
  });

  if (!outcome.ran) {
    // Deterministic policy REFUSE — do NOT throw (a throw would fail the BullMQ job
    // and retry a decision that will never change). Skip + log, like the null case.
    log.info(
      { event_id: event.id, paymentId: payment.id },
      "[stripe-webhook] Payment reconciliation REFUSED by policy — skipped (no retry)",
    );
    return;
  }
  const result = outcome.result;

  if (result === null) {
    log.info(
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
  const eventLogSvc = createOrderEventLogService(log);
  await eventLogSvc.append({
    orderId: payment.orderId,
    eventType: "payment.status_changed",
    discriminator: `${payment.id}:${newStatus}:stripe:${event.id}`,
    payload: { paymentId: payment.id, previousStatus: payment.status, newStatus, stripeEventId: event.id },
    timestamp: new Date(),
  }).catch(() => {});

  log.info(
    { event_id: event.id, paymentId: payment.id, from: payment.status, to: newStatus },
    "[stripe-webhook] Payment reconciled",
  );
}

// ── Event handlers (moved verbatim from stripe-webhook.ts) ──────────────────

async function handlePaymentSucceeded(
  event: Stripe.Event,
  startMs: number,
  log: WebhookLogger,
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const processingMs = Date.now() - startMs;

  log.info(
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
        log.info({ event_id: event.id, cart_id: cartId, order_id: orderId }, "PIX: cart completed, order created");
      }
    } catch (err) {
      log.error({ event_id: event.id, cart_id: cartId, error: String(err) }, "PIX: failed to complete cart");
      // Re-throw so the BullMQ job FAILS and is retried. Previously this was
      // swallowed and the route still returned 200; with the durable async path
      // a failed cart-completion MUST retry rather than strand the order with the
      // idempotency key already claimed.
      throw err;
    }
  }

  if (!orderId) {
    log.warn({ event_id: event.id }, "payment_intent.succeeded missing medusaOrderId metadata");
    return;
  }

  const svc = createOrderService(medusaAdmin);
  // Serialize capture per order. Two distinct payment_intent.succeeded events for
  // one order (realistic after amend_order/regenerate_pix mints a 2nd PI) would
  // otherwise both pass capturePayment's metadata guard and both capture + publish
  // order.placed. The lock makes the read-modify-write atomic; capturePayment's
  // own re-read of metadata.stripePaymentIntentId (now inside the lock) closes the
  // window for the loser. withLock returns null on contention — folded into the
  // same "already processed" no-op as capturePayment's null.
  const captureOrderId = orderId; // narrowed to string by the guard above
  const result = await withLock(`order-capture:${captureOrderId}`, () =>
    svc.capturePayment(captureOrderId, paymentIntent.id, {
      amountInCentavos: paymentIntent.amount,
    }),
  );

  if (!result) {
    log.info({ event_id: event.id, order_id: orderId }, "Order already processed — no-op");
    // Still reconcile payment status even if order was already processed
    await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.PAID, event, log);
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
  await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.PAID, event, log);

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
    log.warn({ error: String(err), order_id: orderId }, "[stripe.pix.mark_paid_failed]");
  });

  log.info(
    { event_id: event.id, order_id: orderId, processing_ms: Date.now() - startMs },
    "payment_intent.succeeded processed",
  );
}

async function handlePaymentFailed(
  event: Stripe.Event,
  startMs: number,
  log: WebhookLogger,
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const orderId = paymentIntent.metadata?.["medusaOrderId"];

  log.info(
    { event_id: event.id, type: event.type, processing_ms: Date.now() - startMs },
    "Stripe webhook received",
  );

  // Reconcile payment status → payment_failed
  await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.PAYMENT_FAILED, event, log);

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
  log: WebhookLogger,
): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const orderId = charge.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  log.info(
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
    await reconcilePaymentFromStripe(piId, targetStatus, event, log);
  }

  if (!orderId) {
    log.warn({ event_id: event.id }, "charge.refunded missing medusaOrderId metadata");
    return;
  }

  await publishNatsEvent("order.refunded", {
    eventType: "order.refunded",
    orderId,
    chargeId: charge.id,
    amountRefunded: charge.amount_refunded,
  });

  log.info(
    { event_id: event.id, order_id: orderId, processing_ms: Date.now() - startMs },
    "charge.refunded processed",
  );
}

async function handleChargeDisputeCreated(
  event: Stripe.Event,
  startMs: number,
  log: WebhookLogger,
): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const orderId = dispute.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  log.warn(
    { event_id: event.id, type: event.type, dispute_id: dispute.id, order_id: orderId, processing_ms: processingMs },
    "Stripe charge.dispute.created received — dispute opened",
  );

  // Reconcile payment → disputed
  const piId = typeof dispute.payment_intent === "string"
    ? dispute.payment_intent
    : dispute.payment_intent?.id;
  if (piId) {
    await reconcilePaymentFromStripe(piId, PaymentStatus.DISPUTED, event, log);
  }

  await publishNatsEvent("order.disputed", {
    eventType: "order.disputed",
    orderId: orderId ?? null,
    disputeId: dispute.id,
    amount: dispute.amount,
    reason: dispute.reason,
  });

  log.warn(
    { event_id: event.id, dispute_id: dispute.id, processing_ms: Date.now() - startMs },
    "charge.dispute.created processed",
  );
}

async function handlePaymentIntentCanceled(
  event: Stripe.Event,
  startMs: number,
  log: WebhookLogger,
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const orderId = paymentIntent.metadata?.["medusaOrderId"];
  const processingMs = Date.now() - startMs;

  log.info(
    { event_id: event.id, type: event.type, order_id: orderId, processing_ms: processingMs },
    "Stripe payment_intent.canceled received",
  );

  // Reconcile payment → canceled
  await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.CANCELED, event, log);

  if (!orderId) {
    log.warn({ event_id: event.id }, "payment_intent.canceled missing medusaOrderId metadata");
    return;
  }

  await publishNatsEvent("order.canceled", {
    eventType: "order.canceled",
    orderId,
    stripePaymentIntentId: paymentIntent.id,
    cancellationReason: paymentIntent.cancellation_reason,
  });

  log.info(
    { event_id: event.id, order_id: orderId, processing_ms: Date.now() - startMs },
    "payment_intent.canceled processed",
  );
}

// ── Dispatch (exported for direct unit testing — no BullMQ/Redis needed) ─────

/**
 * Route a verified Stripe event to its handler. Throwing here fails the BullMQ
 * job, which triggers a durable retry (attempts + backoff). Unknown event types
 * are a no-op (Stripe sends events we don't subscribe to).
 */
export async function processStripeEvent(
  data: StripeWebhookJobData,
  log: WebhookLogger,
): Promise<void> {
  const { event, receivedAtMs } = data;
  switch (event.type) {
    case "payment_intent.succeeded":
      await handlePaymentSucceeded(event, receivedAtMs, log);
      break;
    case "payment_intent.payment_failed":
      await handlePaymentFailed(event, receivedAtMs, log);
      break;
    case "charge.refunded":
      await handleChargeRefunded(event, receivedAtMs, log);
      break;
    case "charge.dispute.created":
      await handleChargeDisputeCreated(event, receivedAtMs, log);
      break;
    case "payment_intent.canceled":
      await handlePaymentIntentCanceled(event, receivedAtMs, log);
      break;
    default:
      log.info({ event_id: event.id, type: event.type }, "Unhandled Stripe event type — ignoring");
  }
}

// ── Queue / worker plumbing ──────────────────────────────────────────────────

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  queue ??= createQueue(QUEUE_NAME);
  return queue;
}

/** BullMQ processor — runs the heavy work the route used to await before 200. */
async function processor(job: Job<StripeWebhookJobData>): Promise<void> {
  await processStripeEvent(job.data, logger);
}

/**
 * Enqueue a signature-verified Stripe event for durable async processing.
 * Called by the route AFTER the idempotency claim. Lazily starts the worker so
 * the queue is always being drained in-process wherever the route is registered
 * (register-workers.ts is a non-owned file — see startStripeWebhookProcessor).
 *
 * Throws if the enqueue fails — the route turns that into a downgrade of the
 * idempotency key + 500 so Stripe RE-DELIVERS rather than the order being
 * stranded behind a claimed key with no queued job.
 */
export async function enqueueStripeWebhookEvent(
  event: Stripe.Event,
  receivedAtMs: number,
): Promise<void> {
  // Ensure the worker is draining this queue (idempotent).
  startStripeWebhookProcessor();

  const q = getQueue();
  await q.add(
    event.type,
    { event, receivedAtMs } satisfies StripeWebhookJobData,
    {
      // jobId = event.id gives BullMQ-level dedup too: a duplicate enqueue (e.g.
      // a Stripe re-delivery that slips past the Redis idempotency key after its
      // TTL) collapses onto the same job rather than processing twice.
      jobId: event.id,
      attempts: STRIPE_WEBHOOK_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: STRIPE_WEBHOOK_JOB_BACKOFF_MS },
      // Keep failed jobs (do NOT removeOnFail) so an order that can't complete
      // after all attempts is RETAINED for observability + manual replay, never
      // silently lost. Completed jobs are trimmed by the queue defaults.
      removeOnComplete: true,
    },
  );
}

/**
 * Start the Stripe webhook worker (idempotent).
 *
 * NOTE ON STARTUP WIRING: the central worker registry (register-workers.ts) is a
 * non-owned file this change must not edit. Instead the worker SELF-REGISTERS:
 * it is started lazily from enqueueStripeWebhookEvent() (so it is always running
 * in the same process that accepts the webhook and enqueues), and is also safe to
 * call directly from startup. Calling it repeatedly is a no-op.
 */
export function startStripeWebhookProcessor(): void {
  if (worker) return;
  worker = createWorker(QUEUE_NAME, processor);

  // Surface permanent failures (attempts exhausted). The job stays in the failed
  // set for replay; this makes it observable rather than a silent stranded order.
  worker.on("failed", (job, err) => {
    logger.error(
      {
        err,
        job: QUEUE_NAME,
        event_id: job?.data?.event?.id,
        event_type: job?.data?.event?.type,
        attemptsMade: job?.attemptsMade,
      },
      "[stripe-webhook] job failed — will retry until attempts exhausted, then retained for replay",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", QUEUE_NAME);
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });
}

export async function stopStripeWebhookProcessor(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
