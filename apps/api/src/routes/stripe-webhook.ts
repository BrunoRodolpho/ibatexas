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

import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import {
  getRedisClient,
  rk,
  medusaAdmin,
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
  type PaymentDisputeOpenPayload,
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
import {
  enqueueStripeWebhookEvent,
  startStripeWebhookProcessor,
} from "../jobs/stripe-webhook-processor.js";

// P2-MEM-STRIPENEW: memoize a module-level Stripe client so we don't construct a
// fresh `new Stripe(key)` (with its own HTTP agent/connection pool) on every
// webhook request. Lazy so the key is still read from env at first use.
let stripeClient: Stripe | undefined;

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  stripeClient ??= new Stripe(key);
  return stripeClient;
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

/**
 * BKL-178 — the system-actor `payment.dispute.open` envelope minted for a
 * `charge.dispute.created` event, ALONGSIDE the DISPUTED reconcile. It carries
 * no state mutation (adjudicate-only); `escalateAlwaysOnDispute` ESCALATEs it
 * for human review. `nonce = event.id` keeps redelivery idempotent at the
 * Execution Ledger even past the Redis 7-day window (same Stripe event → same
 * intentHash). Distinct kind from the reconcile, so sharing the nonce does not
 * collide (intentHash folds in `kind`).
 */
function buildDisputeOpenEnvelope(args: {
  readonly paymentId: string;
  readonly disputeAmountCentavos: number;
  readonly event: Stripe.Event;
}) {
  const payload: PaymentDisputeOpenPayload = {
    paymentId: args.paymentId,
    stripeEventId: args.event.id,
    disputeAmountCentavos: args.disputeAmountCentavos,
  };
  return buildEnvelope({
    kind: "payment.dispute.open" as const,
    payload,
    nonce: args.event.id,
    actor: {
      principal: "system",
      sessionId: `stripe-webhook:${args.event.id}`,
    },
    taint: "SYSTEM",
  });
}

type PaymentQuerySvc = ReturnType<typeof createPaymentQueryService>;
type ReconcilePaymentRow = Awaited<
  ReturnType<PaymentQuerySvc["getByStripePaymentIntentId"]>
>;

/**
 * Resolve the Payment row this reconcile is about: the PI lookup, falling back
 * (T2-1) to the order's single ACTIVE payment when the PI id is unknown locally
 * and a `fallbackOrderId` is supplied — but only when that active payment
 * carries no PI id or the SAME PI id (never adopting a stale/foreign PI).
 */
async function resolvePaymentForReconcile(
  paymentQuerySvc: PaymentQuerySvc,
  stripePaymentIntentId: string,
  fallbackOrderId: string | undefined,
  event: Stripe.Event,
  logger: WebhookLogger,
): Promise<ReconcilePaymentRow> {
  const payment = await paymentQuerySvc.getByStripePaymentIntentId(stripePaymentIntentId);
  if (payment || fallbackOrderId === undefined) {
    return payment;
  }
  const active = await paymentQuerySvc.getActiveByOrderId(fallbackOrderId);
  if (
    active &&
    (active.stripePaymentIntentId === null ||
      active.stripePaymentIntentId === stripePaymentIntentId)
  ) {
    logger.info(
      {
        event_id: event.id,
        stripe_pi: stripePaymentIntentId,
        order_id: fallbackOrderId,
        paymentId: active.id,
      },
      "[stripe-webhook] PI lookup missed — adopted the order's active payment via metadata.medusaOrderId (T2-1 fallback)",
    );
    return active;
  }
  return payment;
}

async function reconcilePaymentFromStripe(
  stripePaymentIntentId: string,
  newStatus: (typeof PaymentStatus)[keyof typeof PaymentStatus],
  event: Stripe.Event,
  logger: WebhookLogger,
  /**
   * T2-1 — orderId fallback for the PI lookup. The PI's `medusaOrderId`
   * metadata is OUR OWN stamp (capturePayment's kernel-gated metadata
   * update / the W8-V2 PI-metadata persist), so when the PI id is unknown
   * locally — the Payment row was created WITHOUT it (the PIX flow's
   * order.placed subscriber races this reconcile; or the payment's PI was
   * minted out-of-band) — the order's single ACTIVE payment is the row
   * this signed event is about. Passed ONLY by payment_intent.succeeded
   * (the handler that already resolved an orderId); a payment that already
   * carries a DIFFERENT PI id is never adopted (stale/foreign PI).
   */
  fallbackOrderId?: string,
): Promise<void> {
  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService(logger, {
    auditSink: getAuditSink(),
  });

  const payment = await resolvePaymentForReconcile(
    paymentQuerySvc,
    stripePaymentIntentId,
    fallbackOrderId,
    event,
    logger,
  );
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

/**
 * Governance-driven skips (REFUSE / DEFER / NEEDS_REVIEW) are logged + swallowed
 * — we still ack Stripe with 200 so no retry storm fires (mirrors the existing
 * Task 12 reconcile branch). The audit record captures the kernel decision; ops
 * sees the refusal via metrics. Covers both medusa egress (cart.complete) and
 * stripe egress (paymentIntents.update metadata persist).
 */
function handlePixCompletionError(
  err: unknown,
  event: Stripe.Event,
  cartId: string,
  logger: WebhookLogger,
): void {
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

/**
 * PIX flow: the cart was not completed at checkout time. Now that payment has
 * succeeded, complete the Medusa cart (creating the order) and persist the new
 * orderId back onto the PaymentIntent metadata.
 *
 * ── P0-X9 migration ───────────────────────────────────────────────────
 * The cart-complete POST is a Medusa write — routes through medusaAdjudicated
 * for kernel governance + audit. The Stripe event ID is the deterministic
 * idempotency key (and the envelope's nonce), so a re-delivered webhook produces
 * a byte-identical intentHash and the kernel / Execution Ledger can dedupe even
 * if Stripe retries past the outer Redis 7-day window (matches the Task 12
 * reconcile pattern). sourceSubject = "webhook:stripe:<event.id>" surfaces in
 * audit.
 *
 * Returns the resolved orderId (the original `orderId` when there is nothing to
 * complete). Throws on cart-complete lock contention so the BullMQ job retries.
 */
async function completePixCartIfNeeded(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  orderId: string | undefined,
  logger: WebhookLogger,
): Promise<string | undefined> {
  const cartId = paymentIntent.metadata?.["cartId"];
  if (orderId || !cartId) {
    return orderId;
  }

  // PIXDUP: serialize concurrent payment_intent.succeeded events for the SAME
  // cart with a distributed try-lock (realistic after amend_order/regenerate_pix
  // mints a 2nd PI → a 2nd distinct event.id; the SET-NX gate AND the
  // medusaAdjudicated nonce both key on event.id, so neither dedupes across the
  // two events — only this lock + Medusa's own internal serialization do).
  // Loser gets null and is retried; Medusa's /complete is idempotent
  // (creates an order only when !order_id, else returns the cart's linked
  // order), so a retry re-runs /complete and gets the SAME order — never a
  // strand or a duplicate. (No local `pix:completed` flag: a crash between the
  // flag and completion would strand the order behind a suppressing flag.)
  let contended = false;
  let resolvedOrderId = orderId;
  try {
    const completion = await withLock(`cart-complete:${cartId}`, () =>
      medusaAdjudicated<
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
      }),
    );

    if (completion === null) {
      // Another worker holds the cart-complete lock — mark contention and
      // throw AFTER the try so the governance catch below doesn't swallow it.
      contended = true;
    } else {
      resolvedOrderId = completion.order?.display_id
        ? formatOrderId(completion.order.display_id)
        : completion.order?.id;

      if (resolvedOrderId) {
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
            metadata: { ...paymentIntent.metadata, medusaOrderId: resolvedOrderId },
          },
          {
            sourceSubject: `webhook:stripe:${event.id}`,
            idempotencyKey: `${event.id}:metadata-update:${paymentIntent.id}`,
            auditSink: getAuditSink(),
            log: logger,
          },
        );
        logger.info({ event_id: event.id, cart_id: cartId, order_id: resolvedOrderId }, "PIX: cart completed, order created");
      }
    }
  } catch (err) {
    handlePixCompletionError(err, event, cartId, logger);
  }

  if (contended) {
    logger.info(
      { event_id: event.id, cart_id: cartId },
      "PIX: cart completion in progress on another worker — will retry",
    );
    throw new Error(`cart-complete in progress for cart ${cartId}`);
  }

  return resolvedOrderId;
}

/**
 * W7-P6: route order.service mutations through the kernel-gated wrapper. The
 * adminAdjudicated closure binds the source-subject + audit sink at this call
 * site; the service's mutate() helper picks it up.
 */
function buildWebhookOrderService(event: Stripe.Event, logger: WebhookLogger) {
  return createOrderService(medusaAdmin, {
    adminAdjudicated: (args) =>
      medusaAdjudicated({
        scope: "admin",
        method: args.method,
        path: args.path,
        ...(args.payload === undefined ? {} : { payload: args.payload }),
        ...(args.intentKind ? { intentKind: args.intentKind as never } : {}),
        ...(args.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: args.idempotencyKey }),
        sourceSubject: `webhook:stripe:${event.id}:${args.sourceSubject}`,
        auditSink: getAuditSink(),
        log: logger,
      }),
    log: logger,
  });
}

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

  const orderId = await completePixCartIfNeeded(
    paymentIntent,
    event,
    paymentIntent.metadata?.["medusaOrderId"],
    logger,
  );

  if (!orderId) {
    logger.warn({ event_id: event.id }, "payment_intent.succeeded missing medusaOrderId metadata");
    return;
  }

  const svc = buildWebhookOrderService(event, logger);
  // Serialize capture per order (P0-PAY-2). Two distinct payment_intent.succeeded
  // events for one order (realistic after amend_order/regenerate_pix mints a 2nd PI)
  // would otherwise both pass capturePayment's metadata guard and both capture +
  // publish order.placed. The lock makes the read-modify-write atomic; capturePayment's
  // own re-read of metadata.stripePaymentIntentId (now inside the lock) closes the
  // window for the loser. withLock returns null on contention — folded into the same
  // "already processed" no-op as capturePayment's null.
  //
  // T2-1 — capture-leg failure isolation: a throw here used to fail the whole
  // BullMQ job, and because the route's 7-day idempotency key is already
  // claimed (Stripe will NOT retry) the PAID reconciliation was permanently
  // lost behind a Medusa bookkeeping error. Payment-state truth must land
  // regardless: log the capture failure LOUDLY and fall through to the
  // reconcile (same shape as the lock-contention/already-processed no-op).
  let result: Awaited<ReturnType<typeof svc.capturePayment>> = null;
  try {
    result = await withLock(`order-capture:${orderId}`, () =>
      svc.capturePayment(orderId, paymentIntent.id, {
        amountInCentavos: paymentIntent.amount,
      }),
    );
  } catch (err) {
    logger.error(
      { event_id: event.id, order_id: orderId, error: String(err) },
      "[stripe-webhook] capture leg failed — proceeding to payment reconciliation (payment truth must land)",
    );
  }

  if (!result) {
    logger.info({ event_id: event.id, order_id: orderId }, "Order already processed — no-op");
    // Still reconcile payment status even if order was already processed
    await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.PAID, event, logger, orderId);
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
  await reconcilePaymentFromStripe(paymentIntent.id, PaymentStatus.PAID, event, logger, orderId);

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

/**
 * BKL-178 — the governed dispute-escalation edge. Resolves the Payment row the
 * chargeback is about (the same lookup the reconcile uses), adjudicates a
 * system-actor `payment.dispute.open` envelope, and on the kernel's ESCALATE
 * decision publishes `support.handoff_requested` so the dispute lands on the
 * owner-visible Escalações queue (+ `pendingEscalations` KPI) via the existing
 * handoff-subscriber — which also fires the staff WhatsApp ping (one governed
 * record + one ping). Idempotent on `event.id` (envelope nonce) and
 * `dispute.id` (handoff sessionId), so Stripe redelivery never double-escalates.
 */
async function escalateDisputeOpen(
  dispute: Stripe.Dispute,
  piId: string,
  orderId: string | undefined,
  event: Stripe.Event,
  logger: WebhookLogger,
): Promise<void> {
  const paymentQuerySvc = createPaymentQueryService();
  const payment = await resolvePaymentForReconcile(
    paymentQuerySvc,
    piId,
    orderId,
    event,
    logger,
  );
  if (!payment) {
    // No local Payment row (e.g. a PIX cart that never completed). The
    // order.disputed event still fires downstream; without a paymentId there is
    // no governed envelope to build, so log rather than escalate a phantom.
    logger.warn(
      { event_id: event.id, dispute_id: dispute.id, stripe_pi: piId },
      "[stripe-webhook] dispute opened but no local Payment row — no governed dispute.open envelope",
    );
    return;
  }

  const paymentCmdSvc = createPaymentCommandService(logger, {
    auditSink: getAuditSink(),
  });
  const envelope = buildDisputeOpenEnvelope({
    paymentId: payment.id,
    disputeAmountCentavos: dispute.amount,
    event,
  });
  const outcome = await paymentCmdSvc.disputeOpenFromEnvelope(envelope);

  if (outcome.decision.kind === "ESCALATE") {
    // The missing edge — route the audited ESCALATE to the owner escalation
    // surface. sessionId is a synthetic non-conversation key; the handoff
    // subscriber records it (Escalações + KPI) and pings staff. A transcript
    // lookup on this sessionId 404s harmlessly (no conversation exists).
    await publishNatsEvent("support.handoff_requested", {
      sessionId: `dispute:${dispute.id}`,
      reason: "payment_disputed",
    });
    logger.warn(
      { event_id: event.id, dispute_id: dispute.id, paymentId: payment.id },
      "[stripe-webhook] payment.dispute.open ESCALATEd — support handoff published",
    );
    return;
  }

  // Defensive: dispute.open is always-ESCALATE by policy. Any other decision is
  // a policy-contract change — surface loudly. The reconcile already wrote the
  // DISPUTED status truth, so nothing is silently lost.
  logger.error(
    {
      event_id: event.id,
      dispute_id: dispute.id,
      paymentId: payment.id,
      decision: outcome.decision.kind,
    },
    "[stripe-webhook] payment.dispute.open did not ESCALATE — unexpected policy decision",
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

  // Reconcile payment → disputed (status truth)
  const piId = typeof dispute.payment_intent === "string"
    ? dispute.payment_intent
    : dispute.payment_intent?.id;
  if (piId) {
    await reconcilePaymentFromStripe(piId, PaymentStatus.DISPUTED, event, logger);
    // BKL-178 — governed dispute escalation: mint + adjudicate a system-actor
    // payment.dispute.open envelope (always ESCALATEs) and, on ESCALATE, surface
    // it to the owner escalation queue via support.handoff_requested. Runs after
    // the reconcile so the resolved Payment row is authoritative.
    await escalateDisputeOpen(dispute, piId, orderId, event, logger);
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

// ── Dispatch (runs inside the BullMQ processor, NOT the HTTP handler) ─────────

/**
 * Route a verified Stripe event to its handler. Invoked by the
 * stripe-webhook-processor worker (ack-then-async, P1-NET-STRIPESYNC) — the HTTP
 * route only verifies + enqueues. `receivedAtMs` is the webhook receipt time so
 * each handler's processing_ms reflects end-to-end latency. The handlers retain
 * their kernel-adjudicated egress + the P0-PAY-1/P0-PAY-2/PIXDUP/STRIPESRC fixes.
 */
export async function dispatchStripeWebhookEvent(
  event: Stripe.Event,
  receivedAtMs: number,
  logger: WebhookLogger,
): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded":
      await handlePaymentSucceeded(event, receivedAtMs, logger);
      break;
    case "payment_intent.payment_failed":
      await handlePaymentFailed(event, receivedAtMs, logger);
      break;
    case "charge.refunded":
      await handleChargeRefunded(event, receivedAtMs, logger);
      break;
    case "charge.dispute.created":
      await handleChargeDisputeCreated(event, receivedAtMs, logger);
      break;
    case "payment_intent.canceled":
      await handlePaymentIntentCanceled(event, receivedAtMs, logger);
      break;
    default:
      logger.info({ event_id: event.id, type: event.type }, "Unhandled Stripe event type — ignoring");
  }
}

// ── Route registration ──────────────────────────────────────────────────────

export async function stripeWebhookRoutes(server: FastifyInstance): Promise<void> {
  // Self-register the durable processor so queued jobs drain on (re)start.
  // Guarded out of the UNIT-test env (no BullMQ/Redis worker in vitest); the
  // handlers themselves are exercised via dispatchStripeWebhookEvent.
  //
  // T2-1 — prod-parity on the journey test stack (the D-014 subscriber-gating
  // fix class): the ephemeral test profile boots with NODE_ENV=test AND
  // IBX_TEST_FINGERPRINT (only .env.test carries the fingerprint — D-010), and
  // it MUST drain webhook jobs or the signed paid-state fixture's events would
  // be acked-then-stranded. Mirrors apps/api/src/index.ts:133.
  if (process.env.NODE_ENV !== "test" || process.env.IBX_TEST_FINGERPRINT) {
    startStripeWebhookProcessor(dispatchStripeWebhookEvent);
  }

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

      // P3-SEC-STRIPESRC: bind the event's mode to the API key's mode. The signature
      // check proves the event came from whoever holds the webhook secret, but not that
      // its mode matches this deployment — a test-mode event reaching a live deployment
      // (or vice versa), e.g. via a leaked/shared secret or a misconfigured Connect
      // setup, must be refused BEFORE its metadata drives order completion. `sk_live_`
      // ⇒ expect livemode true; anything else (sk_test_, unset) ⇒ expect false.
      const expectedLivemode = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_");
      if (event.livemode !== expectedLivemode) {
        server.log.warn(
          {
            event_id: event.id,
            event_livemode: event.livemode,
            expected_livemode: expectedLivemode,
            action: "stripe_livemode_mismatch",
          },
          "Stripe webhook livemode mismatch — refusing",
        );
        return reply.code(400).send({ error: "Webhook livemode mismatch" });
      }

      // Idempotency — 7 days covers Stripe's 3-day retry window with margin
      const redis = await getRedisClient();
      const idempotencyKey = rk(`webhook:processed:${event.id}`);
      const wasSet = await redis.set(idempotencyKey, "1", { EX: 604800, NX: true });
      if (!wasSet) {
        // Already processed — return 200 immediately, no side-effects
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      // Ack-then-async (P1-NET-STRIPESYNC): enqueue a durable BullMQ job and
      // return 200 immediately, instead of running the heavy Medusa-complete +
      // capture + NATS + reconcile work inline (which held the HTTP connection
      // open and risked a Stripe client timeout → retry storm + double-process).
      // The 7-day idempotency key is already claimed above, so Stripe will NOT
      // retry — durability now rests on BullMQ (jobId=event.id dedup + attempts +
      // failed-set retention), not on Stripe.
      //
      // Bad-money-port trap: if the ENQUEUE ITSELF fails (Redis/BullMQ down), the
      // claimed key would otherwise suppress Stripe's retry forever and the event
      // would be lost. So downgrade the key to a 300s TTL and return 500 → Stripe
      // re-delivers and we re-enqueue once the queue recovers. (Processing-time
      // failures are handled by BullMQ retry, not here.)
      try {
        await enqueueStripeWebhookEvent(event, startMs);
      } catch (err) {
        server.log.error(
          { event_id: event.id, error: String(err) },
          "[stripe-webhook] enqueue failed — downgrading idempotency key for Stripe retry",
        );
        await redis.expire(idempotencyKey, 300);
        return reply.code(500).send({ error: "Failed to enqueue webhook event" });
      }

      return reply.code(200).send({ ok: true });
    },
  );
  }); // end stripeWebhookPlugin register
}
