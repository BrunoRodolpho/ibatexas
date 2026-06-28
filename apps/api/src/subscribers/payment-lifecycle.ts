// NATS subscriber: payment.status_changed
//
// Reacts to payment state transitions to coordinate cross-context effects:
//   - `paid` → auto-confirm order (pending → confirmed) for PIX/card
//   - `refunded` on pending/confirmed order → cancel order
//   - `payment_expired` → send customer notification (retry/switch)
//   - `payment_failed` → send customer notification
//
// INVARIANT: Payment is the source of truth for billing.
// This subscriber bridges the Billing → Commerce boundary via NATS events.
//
// ── Task 16 (M3) — kernel-gated auto-confirm / auto-cancel ────────────────
//
// Per investigation 04 P0 #1: payment-lifecycle auto-confirms / auto-cancels
// orders by webhook with ZERO kernel review. A forged NATS event today can
// confirm or cancel any order — no per-message auth. This subscriber now
// builds a SYSTEM-actor IntentEnvelope and routes the order transition
// through `orderCmdSvc.transitionStatusFromEnvelope(envelope)` (Task 15).
//
//   - kind:               order.status.transition
//   - actor.principal:    "system"
//   - actor.sessionId:    `payment.status_changed:${paymentId}:${newStatus}`
//   - taint:              "SYSTEM"
//   - nonce:              `${paymentId}:${newStatus}` (deterministic per event)
//
// On REFUSE the original NATS payload is pushed to the DLQ for ops
// inspection. EXECUTE / REWRITE proceed; DEFER / REQUEST_CONFIRMATION /
// ESCALATE log the outcome and skip the mutation (the kernel decision
// metric surfaces the refusal upstream).
//
// Existing dedup (`isNewEvent`) and event-log archival are preserved.

import { subscribeNatsEvent, publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderQueryService,
  createOrderEventLogService,
  type OrderStatusTransitionPayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import {
  OrderFulfillmentStatus,
  PaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import type { FastifyBaseLogger } from "fastify";
import { withDedup } from "./dedup.js";
import { pushToDlq } from "./dlq.js";
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js";

// Expected, benign failures when advancing an order's status: another process
// (or a prior delivery) already advanced it. These are info-level — NOT money-at-
// risk. Anything else is unexpected and must be escalated (DLQ + staff alert).
const EXPECTED_TRANSITION_ERRORS = new Set([
  "ConcurrencyError",
  "InvalidTransitionError",
]);

function isExpectedTransitionError(err: unknown): boolean {
  return err instanceof Error && EXPECTED_TRANSITION_ERRORS.has(err.name);
}

type OrderCommandService = ReturnType<typeof createOrderCommandService>;
type OrderQueryService = ReturnType<typeof createOrderQueryService>;

interface PaymentLifecycleDeps {
  readonly orderCmdSvc: OrderCommandService;
  readonly orderQuerySvc: OrderQueryService;
  readonly log?: FastifyBaseLogger;
}

// The adjudicated outcome returned by the order command service. Aliased here so
// the shared decision-gate helper can narrow the discriminated `decision` union
// (REFUSE carries `refusal.code`) exactly as the inlined call sites did.
type TransitionOutcome = Awaited<
  ReturnType<OrderCommandService["transitionStatusFromEnvelope"]>
>;

// ── Shared: kernel decision gate ────────────────────────────────────────────
// The auto-confirm and auto-cancel handlers gate their NATS mutation on the same
// kernel decision: proceed only on EXECUTE / REWRITE; on REFUSE / DEFER /
// REQUEST_CONFIRMATION / ESCALATE the mutation is skipped (warn-logged), and a
// REFUSE additionally pushes the raw payload to the DLQ. Returns `true` when the
// caller should proceed with the mutation, `false` when it was skipped. Behavior
// is byte-identical to the previously-inlined blocks; only `action` (the
// human-readable label in the warn message) varies per call site.
async function kernelAuthorizedMutation(
  outcome: TransitionOutcome,
  ctx: {
    orderId: string;
    paymentId: string;
    rawPayload: Record<string, unknown>;
    action: "auto-confirm" | "auto-cancel";
    log?: FastifyBaseLogger;
  },
): Promise<boolean> {
  const { orderId, paymentId, rawPayload, action, log } = ctx;
  if (
    outcome.decision.kind !== "EXECUTE" &&
    outcome.decision.kind !== "REWRITE"
  ) {
    // REFUSE / DEFER / REQUEST_CONFIRMATION / ESCALATE — mutation skipped.
    const decisionKind = outcome.decision.kind;
    const refusalCode =
      outcome.decision.kind === "REFUSE"
        ? outcome.decision.refusal.code
        : undefined;
    log?.warn(
      { orderId, paymentId, decision: decisionKind, refusalCode },
      `[payment-lifecycle] kernel did not authorize ${action} — mutation skipped`,
    );
    if (outcome.decision.kind === "REFUSE") {
      await pushToDlq(
        "payment.status_changed",
        rawPayload,
        `kernel REFUSE: ${outcome.decision.refusal.code}`,
        log,
      );
    }
    return false;
  }
  return true;
}

// ── Shared: post-transition error escalation ────────────────────────────────
// Both handlers wrap their kernel-gated transition + publish in an identical
// try/catch. An EXPECTED transition error (Concurrency / InvalidTransition) means
// another process already advanced the order — benign, info-level. Anything else
// is money-at-risk (money moved but the order did not follow) and is escalated:
// DLQ + an `order.escalation_needed` event. The skipped/failed log messages and
// the escalation `reason` are the only per-call-site variations, passed in so the
// emitted log content and event payload stay byte-identical to the inlined code.
async function escalateTransitionError(
  err: unknown,
  ctx: {
    orderId: string;
    paymentId: string;
    rawPayload: Record<string, unknown>;
    skippedMsg: string;
    failedMsg: string;
    escalationReason: string;
    log?: FastifyBaseLogger;
  },
): Promise<void> {
  const { orderId, paymentId, rawPayload, skippedMsg, failedMsg, escalationReason, log } = ctx;
  if (isExpectedTransitionError(err)) {
    // ConcurrencyError / InvalidTransitionError — another process (or a prior
    // delivery) already advanced the order. Benign, info-level.
    log?.info(
      { orderId, paymentId, error: String(err) },
      skippedMsg,
    );
  } else {
    // Unexpected: money moved but the order did NOT follow and nobody is
    // watching. Escalate (DLQ + staff alert) like the disputed branch instead
    // of letting the payload evaporate into a warn log.
    log?.error(
      { orderId, paymentId, error: String(err) },
      failedMsg,
    );
    await pushToDlq(
      "payment.status_changed",
      rawPayload,
      err,
      log,
    );
    await publishNatsEvent("order.escalation_needed", {
      eventType: "order.escalation_needed",
      orderId,
      reason: escalationReason,
      paymentId,
      timestamp: new Date().toISOString(),
    });
  }
}

// ── Payment confirmed → auto-confirm order ──────────────────────────────────
// Extracted from the dispatch switch to keep the subscriber callback's
// cognitive complexity bounded. Behavior is identical to the inlined case.
async function handlePaymentPaid(
  deps: PaymentLifecycleDeps,
  event: PaymentStatusChangedEvent & { eventType?: string },
  rawPayload: Record<string, unknown>,
): Promise<void> {
  const { orderCmdSvc, orderQuerySvc, log } = deps;
  const { orderId, paymentId, newStatus, method } = event;

  // Only auto-confirm for electronic payments (PIX/card).
  // Cash orders are confirmed via admin workflow.
  if (method === "cash") return;

  const order = await orderQuerySvc.getById(orderId);
  if (!order) return;

  // Only advance pending → confirmed
  if (order.fulfillmentStatus !== "pending") {
    log?.info(
      { orderId, fulfillmentStatus: order.fulfillmentStatus },
      "[payment-lifecycle] Order not pending — skipping auto-confirm",
    );
    return;
  }

  // ── Task 16: kernel-gated transition ──────────────────────────
  const transitionPayload: OrderStatusTransitionPayload = {
    orderId,
    newStatus: OrderFulfillmentStatus.CONFIRMED,
    actor: "system",
    reason: "Pagamento confirmado",
  };
  const envelope = buildSystemEnvelope({
    kind: "order.status.transition" as const,
    payload: transitionPayload,
    sourceSubject: "payment.status_changed",
    eventId: `auto_confirm:${paymentId}:${newStatus}`,
  });

  try {
    const outcome = await orderCmdSvc.transitionStatusFromEnvelope(envelope);

    if (
      !(await kernelAuthorizedMutation(outcome, {
        orderId,
        paymentId,
        rawPayload,
        action: "auto-confirm",
        log,
      }))
    ) {
      return;
    }

    await publishNatsEvent("order.status_changed", {
      eventType: "order.status_changed",
      orderId,
      displayId: order.displayId,
      previousStatus: OrderFulfillmentStatus.PENDING,
      newStatus: OrderFulfillmentStatus.CONFIRMED,
      customerId: order.customerId ?? null,
      updatedBy: "system",
      version: order.version + 1,
      timestamp: new Date().toISOString(),
    });

    log?.info({ orderId }, "[payment-lifecycle] Order auto-confirmed after payment");
  } catch (err) {
    await escalateTransitionError(err, {
      orderId,
      paymentId,
      rawPayload,
      skippedMsg: "[payment-lifecycle] Auto-confirm skipped — order already advanced",
      failedMsg: "[payment-lifecycle] Auto-confirm FAILED unexpectedly — escalating (DLQ + staff alert)",
      escalationReason: "auto_confirm_failed",
      log,
    });
  }
}

// ── Payment refunded on pending/confirmed → cancel order ────────────────────
// Extracted from the dispatch switch to keep the subscriber callback's
// cognitive complexity bounded. Behavior is identical to the inlined case.
async function handlePaymentRefunded(
  deps: PaymentLifecycleDeps,
  event: PaymentStatusChangedEvent & { eventType?: string },
  rawPayload: Record<string, unknown>,
): Promise<void> {
  const { orderCmdSvc, orderQuerySvc, log } = deps;
  const { orderId, paymentId, newStatus } = event;

  const order = await orderQuerySvc.getById(orderId);
  if (!order) return;

  const cancelable = [
    OrderFulfillmentStatus.PENDING,
    OrderFulfillmentStatus.CONFIRMED,
  ] as string[];

  if (!cancelable.includes(order.fulfillmentStatus)) {
    log?.info(
      { orderId, fulfillmentStatus: order.fulfillmentStatus },
      "[payment-lifecycle] Order past cancelable state — skipping auto-cancel on refund",
    );
    return;
  }

  // ── Task 16: kernel-gated cancel ──────────────────────────────
  const cancelPayload: OrderStatusTransitionPayload = {
    orderId,
    newStatus: OrderFulfillmentStatus.CANCELED,
    actor: "system",
    reason: "Pagamento reembolsado",
  };
  const envelope = buildSystemEnvelope({
    kind: "order.status.transition" as const,
    payload: cancelPayload,
    sourceSubject: "payment.status_changed",
    eventId: `auto_cancel:${paymentId}:${newStatus}`,
  });

  try {
    const outcome = await orderCmdSvc.transitionStatusFromEnvelope(envelope);

    if (
      !(await kernelAuthorizedMutation(outcome, {
        orderId,
        paymentId,
        rawPayload,
        action: "auto-cancel",
        log,
      }))
    ) {
      return;
    }

    await publishNatsEvent("order.canceled", {
      eventType: "order.canceled",
      orderId,
      displayId: order.displayId,
      customerId: order.customerId ?? null,
      reason: "Pagamento reembolsado",
      canceledBy: "system",
      timestamp: new Date().toISOString(),
    });

    log?.info({ orderId }, "[payment-lifecycle] Order canceled after full refund");
  } catch (err) {
    await escalateTransitionError(err, {
      orderId,
      paymentId,
      rawPayload,
      skippedMsg: "[payment-lifecycle] Auto-cancel skipped — order already advanced",
      failedMsg: "[payment-lifecycle] Auto-cancel after refund FAILED unexpectedly — escalating (DLQ + staff alert)",
      escalationReason: "refund_cancel_failed",
      log,
    });
  }
}

export async function startPaymentLifecycleSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  const orderCmdSvc = createOrderCommandService(log ?? undefined, {
    auditSink: getAuditSink(),
  });
  const orderQuerySvc = createOrderQueryService();
  const eventLogSvc = createOrderEventLogService(log);

  await subscribeNatsEvent("payment.status_changed", async (payload) => {
    const event = payload as unknown as PaymentStatusChangedEvent & { eventType?: string };
    const { orderId, paymentId, newStatus, method } = event;

    log?.info(
      { orderId, paymentId, newStatus, method },
      "[payment-lifecycle] payment.status_changed received",
    );

    // Two-phase idempotency guard: the processed-key is only promoted to the
    // full dedup TTL AFTER the body below succeeds. A handler throw releases the
    // claim so redelivery reprocesses (at-least-once); a Redis error while
    // claiming fails CLOSED (DedupUnavailableError propagates to the nats-client
    // subscribe loop → DLQ) so the event is left for redelivery rather than
    // processed unguarded. Money-at-risk failures (unexpected transition errors)
    // are escalated INSIDE the handler, so they do NOT release the claim.
    const processed = await withDedup(`payment-lifecycle:${paymentId}:${newStatus}`, async () => {
      // Audit trail: record every payment status change
      await eventLogSvc.append({
        orderId,
        eventType: "payment.status_changed",
        discriminator: `${paymentId}:${newStatus}`,
        payload: { paymentId, previousStatus: event.previousStatus, newStatus, method, version: event.version },
        timestamp: new Date(),
      }).catch(() => {}); // Fire-and-forget — never block on event log

      switch (newStatus) {
        // ── Payment confirmed → auto-confirm order ────────────────────────
        case PaymentStatus.PAID:
          await handlePaymentPaid(
            { orderCmdSvc, orderQuerySvc, log },
            event,
            payload as Record<string, unknown>,
          );
          break;

        // ── Payment refunded on pending/confirmed → cancel order ──────────
        case PaymentStatus.REFUNDED:
          await handlePaymentRefunded(
            { orderCmdSvc, orderQuerySvc, log },
            event,
            payload as Record<string, unknown>,
          );
          break;

        // ── Payment expired → notify customer ─────────────────────────────
        case PaymentStatus.PAYMENT_EXPIRED: {
          await publishNatsEvent("notification.send", {
            type: "payment_expired",
            customerId: undefined, // resolved by notification handler from orderId
            body: `Seu pagamento PIX expirou. Você pode gerar um novo QR code ou escolher outra forma de pagamento.`,
            targetType: "customer",
          });
          log?.info({ orderId, paymentId }, "[payment-lifecycle] Payment expired notification sent");
          break;
        }

        // ── Payment failed → notify customer ──────────────────────────────
        case PaymentStatus.PAYMENT_FAILED: {
          await publishNatsEvent("notification.send", {
            type: "payment_failed",
            customerId: undefined,
            body: `Houve um problema com seu pagamento. Tente novamente ou escolha outra forma de pagamento.`,
            targetType: "customer",
          });
          log?.info({ orderId, paymentId }, "[payment-lifecycle] Payment failed notification sent");
          break;
        }

        // ── Payment disputed → escalate to staff ──────────────────────
        case PaymentStatus.DISPUTED: {
          await publishNatsEvent("order.escalation_needed", {
            eventType: "order.escalation_needed",
            orderId,
            reason: "payment_disputed",
            paymentId,
            timestamp: new Date().toISOString(),
          });
          log?.warn({ orderId, paymentId }, "[payment-lifecycle] Payment disputed — staff notified");
          break;
        }

        // ── Partial refund applied → log only ─────────────────────────
        case PaymentStatus.PARTIALLY_REFUNDED: {
          log?.info({ orderId, paymentId, method }, "[payment-lifecycle] Partial refund applied — no order status change");
          break;
        }

        default:
          break;
      }
    });

    // processed === false is a benign duplicate skip. A failed dedup claim
    // (Redis down) throws DedupUnavailableError out of withDedup, and a handler
    // throw is re-raised after releasing the claim — both propagate to the
    // nats-client subscribe loop, which routes them to the DLQ (P1-ERR-NATSLOOP).
    if (!processed) {
      log?.info({ paymentId, newStatus }, "[payment-lifecycle] duplicate — skipping");
    }
  }, { queueGroup: "payment-lifecycle" });

  log?.info("[payment-lifecycle] Subscriber started");
}
