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
//
// ── Task 12 (M3) — kernel-gated reconciliation ────────────────────────────
//
// Stripe payment-state reconciliation now flows through an IntentEnvelope
// adjudicated by the kernel before the executor runs. Per investigation 02
// P0 #1 and the M3 master plan, this closes the bare-arg bypass at the
// highest-blast-radius mutation path.
//
//   - Envelope kind:  payment.status.reconcile
//   - actor.principal: "system"
//   - actor.sessionId: `stripe-webhook:${event.id}` (operator traceability)
//   - taint:           "SYSTEM"
//   - nonce:           event.id (deterministic intentHash per Stripe event;
//                                replay-safe — re-delivering the same
//                                event produces the same hash and the
//                                Execution Ledger / kernel can dedupe)
//
// The kernel decision is branched: EXECUTE / REWRITE proceed with the
// reconcile; REFUSE / DEFER / ESCALATE / REQUEST_CONFIRMATION log the
// outcome and skip the mutation (Stripe still gets 200; if Stripe should
// retry, the outer 5xx error path fires for signature / parsing errors
// only). The audit record is emitted by withAdjudicate inside the
// PaymentCommandService chokepoint via the configured AuditSink.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import {
  getRedisClient,
  rk,
  medusaAdmin,
  medusaStore,
  withLock,
  medusaAdjudicated,
  MedusaAdjudicateRefusedError,
  MedusaAdjudicateDeferredError,
  MedusaAdjudicateNeedsReviewError,
  stripeAdjudicated,
  StripeAdjudicateRefusedError,
  StripeAdjudicateDeferredError,
  StripeAdjudicateNeedsReviewError,
} from "@ibatexas/tools";
import {
  createOrderService,
  createPaymentCommandService,
  createPaymentQueryService,
  createOrderEventLogService,
  type PaymentStatusReconcilePayload,
} from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { buildEnvelope } from "@adjudicate/core";
import { getAuditSink } from "@ibatexas/audit-sink";
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

/**
 * Build a `payment.status.reconcile` IntentEnvelope for a Stripe webhook
 * event. Task 12 (M3): the envelope is the canonical capture of every
 * webhook-driven mutation. `nonce = event.id` so reconstruction is
 * deterministic (same Stripe event → same `intentHash`) which keeps the
 * Execution Ledger able to dedupe even if Stripe retries past the Redis
 * 7-day window.
 */
function buildReconcileEnvelope(args: {
  readonly paymentId: string;
  readonly orderId: string;
  readonly newStatus: (typeof PaymentStatus)[keyof typeof PaymentStatus];
  readonly event: Stripe.Event;
}) {
  const payload: PaymentStatusReconcilePayload = {
    paymentId: args.paymentId,
    newStatus: args.newStatus,
    stripeEventId: args.event.id,
    stripeEventTimestamp: new Date(args.event.created * 1000).toISOString(),
    expectedOrderId: args.orderId,
  };
  return buildEnvelope({
    kind: "payment.status.reconcile" as const,
    payload,
    nonce: args.event.id,
    actor: {
      principal: "system",
      sessionId: `stripe-webhook:${args.event.id}`,
    },
    taint: "SYSTEM",
  });
}

async function reconcilePaymentFromStripe(
  stripePaymentIntentId: string,
  newStatus: (typeof PaymentStatus)[keyof typeof PaymentStatus],
  event: Stripe.Event,
  logger: WebhookLogger,
): Promise<void> {
  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService(logger, {
    auditSink: getAuditSink(),
  });

  const payment = await paymentQuerySvc.getByStripePaymentIntentId(stripePaymentIntentId);
  if (!payment) {
    // Payment row may not exist yet (e.g. PIX cart completion creates it later)
    logger.info(
      { event_id: event.id, stripe_pi: stripePaymentIntentId },
      "[stripe-webhook] No Payment row found for PI — skipping reconciliation",
    );
    return;
  }

  // ── Kernel-gated reconcile (Task 12 — M3) ──────────────────────────────
  // Build the envelope OUTSIDE the lock so the kernel can REFUSE / DEFER
  // without holding the per-payment Redis lock. The executor is invoked
  // INSIDE the lock (preserves CLAUDE.md rule #10 — distributed
  // concurrency on the payment row); the kernel adjudication is pure +
  // deterministic so it does not need the lock.
  let envelope: ReturnType<typeof buildReconcileEnvelope>;
  try {
    envelope = buildReconcileEnvelope({
      paymentId: payment.id,
      orderId: payment.orderId,
      newStatus,
      event,
    });
  } catch (err) {
    // Envelope construction is defensive — the inputs come from a
    // verified Stripe event and our own DB. A throw here means our
    // contract has drifted (e.g., missing event.id). Surface as a 5xx
    // by re-throwing into the outer route's try/catch.
    logger.error(
      { event_id: event.id, paymentId: payment.id, error: String(err) },
      "[stripe-webhook] envelope construction failed",
    );
    throw err;
  }

  const outcome = await withLock(`payment:${payment.id}`, async () => {
    return paymentCmdSvc.reconcileFromWebhookFromEnvelope(envelope);
  }, 30);

  // withLock returns null when the lock cannot be acquired within the
  // timeout. Treat as "another worker is reconciling this payment" — no
  // mutation here, audit was not emitted by the executor either.
  if (outcome === null) {
    logger.info(
      { event_id: event.id, paymentId: payment.id },
      "[stripe-webhook] Payment reconciliation skipped (lock contention)",
    );
    return;
  }

  // Branch on the kernel's Decision. The audit record was emitted by
  // withAdjudicate inside the PaymentCommandService chokepoint.
  if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
    // REFUSE / DEFER / REQUEST_CONFIRMATION / ESCALATE — the mutation
    // did NOT run. Log at warn (REFUSE / DEFER are expected for an
    // out-of-order or terminal state) or error (ESCALATE) depending on
    // the kind. We still return 200 to Stripe so no retry storm fires
    // for governance-driven skips; ops sees the refusal via the audit
    // stream + kernel decision metrics.
    const decisionKind = outcome.decision.kind;
    const refusalCode =
      outcome.decision.kind === "REFUSE"
        ? outcome.decision.refusal.code
        : undefined;
    const escalateReason =
      outcome.decision.kind === "ESCALATE"
        ? outcome.decision.reason
        : undefined;
    const log =
      outcome.decision.kind === "ESCALATE" ? logger.error : logger.warn;
    log.call(
      logger,
      {
        event_id: event.id,
        paymentId: payment.id,
        decision: decisionKind,
        refusalCode,
        escalateReason,
        attemptedStatus: newStatus,
      },
      "[stripe-webhook] kernel did not authorize reconcile — mutation skipped",
    );
    return;
  }

  // EXECUTE / REWRITE — the reconcile ran. `result` is null when the
  // executor's own idempotency / terminal / out-of-order / ownership
  // checks skipped the write (matches the legacy bare-arg return shape).
  const result = outcome.result ?? null;
  if (result === null) {
    logger.info(
      { event_id: event.id, paymentId: payment.id },
      "[stripe-webhook] Payment reconciliation skipped (terminal, out-of-order, or already at target)",
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
  //
  // ── P0-X9 migration ───────────────────────────────────────────────────
  // The cart-complete POST is a Medusa write — routes through
  // medusaAdjudicated for kernel governance + audit. The Stripe event ID
  // is the deterministic idempotency key (and the envelope's nonce), so a
  // re-delivered webhook produces a byte-identical intentHash and the
  // kernel / Execution Ledger can dedupe even if Stripe retries past the
  // outer Redis 7-day window (matches the Task 12 reconcile pattern).
  // sourceSubject = "webhook:stripe:<event.id>" surfaces in audit.
  const cartId = paymentIntent.metadata?.["cartId"];
  if (!orderId && cartId) {
    try {
      const completedData = await medusaAdjudicated<
        Record<string, unknown>,
        { type?: string; order?: { id: string; display_id?: number } }
      >({
        scope: "store",
        method: "POST",
        path: `/store/carts/${cartId}/complete`,
        payload: {},
        intentKind: "medusa.cart.complete",
        idempotencyKey: event.id,
        sourceSubject: `webhook:stripe:${event.id}`,
        auditSink: getAuditSink(),
        log: logger,
      });

      orderId = completedData.order?.display_id
        ? formatOrderId(completedData.order.display_id)
        : completedData.order?.id;

      if (orderId) {
        // W8-V2 (NEW-W7-V2): persist orderId back to the PaymentIntent
        // through the kernel-gated wrapper rather than a bare Stripe SDK
        // call. The bare `stripe.paymentIntents.update(...)` here was the
        // last surviving stripe.* bypass in apps/api/src/routes/ after
        // W7-P5 closed the cart-tool sites; it slipped past W7-P5's
        // scope. The idempotency key keys the metadata-update to the
        // Stripe event so a re-delivered webhook produces a
        // byte-identical envelope hash (replay-safe).
        await stripeAdjudicated.paymentIntents.update(
          paymentIntent.id,
          {
            metadata: { ...paymentIntent.metadata, medusaOrderId: orderId },
          },
          {
            sourceSubject: `webhook:stripe:${event.id}`,
            idempotencyKey: `${event.id}:metadata-update:${paymentIntent.id}`,
            auditSink: getAuditSink(),
            log: logger,
          },
        );
        logger.info({ event_id: event.id, cart_id: cartId, order_id: orderId }, "PIX: cart completed, order created");
      }
    } catch (err) {
      // Governance-driven skips (REFUSE / DEFER / NEEDS_REVIEW) are
      // logged + swallowed — we still ack Stripe with 200 so no retry
      // storm fires (mirrors the existing Task 12 reconcile branch).
      // The audit record captures the kernel decision; ops sees the
      // refusal via metrics. Covers both medusa egress (cart.complete)
      // and stripe egress (paymentIntents.update metadata persist).
      if (
        err instanceof MedusaAdjudicateRefusedError ||
        err instanceof MedusaAdjudicateDeferredError ||
        err instanceof MedusaAdjudicateNeedsReviewError ||
        err instanceof StripeAdjudicateRefusedError ||
        err instanceof StripeAdjudicateDeferredError ||
        err instanceof StripeAdjudicateNeedsReviewError
      ) {
        logger.warn(
          {
            event_id: event.id,
            cart_id: cartId,
            kind: err.name,
            code:
              err instanceof MedusaAdjudicateRefusedError ||
              err instanceof StripeAdjudicateRefusedError
                ? err.code
                : undefined,
          },
          "PIX: cart-complete or metadata-persist refused/deferred by kernel",
        );
      } else {
        logger.error({ event_id: event.id, cart_id: cartId, error: String(err) }, "PIX: failed to complete cart");
      }
    }
  }

  if (!orderId) {
    logger.warn({ event_id: event.id }, "payment_intent.succeeded missing medusaOrderId metadata");
    return;
  }

  // W7-P6: route order.service mutations through the kernel-gated wrapper.
  // The adminAdjudicated closure binds the source-subject + audit sink at
  // this call site; the service's mutate() helper picks it up.
  const svc = createOrderService(medusaAdmin, {
    adminAdjudicated: (args) =>
      medusaAdjudicated({
        scope: "admin",
        method: args.method,
        path: args.path,
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
        ...(args.intentKind ? { intentKind: args.intentKind as never } : {}),
        ...(args.idempotencyKey !== undefined
          ? { idempotencyKey: args.idempotencyKey }
          : {}),
        sourceSubject: `webhook:stripe:${event.id}:${args.sourceSubject}`,
        auditSink: getAuditSink(),
        log: logger,
      }),
    log: logger,
  });
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
