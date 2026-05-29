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

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderQueryService,
  createOrderEventLogService,
} from "@ibatexas/domain";
import {
  OrderFulfillmentStatus,
  PaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import type { FastifyBaseLogger } from "fastify";
import { withDedup } from "./dedup.js";
import { pushToDlq } from "./dlq.js";

// Expected, benign failures when advancing an order's status: another process
// (or a prior delivery) already advanced it. These are info-level — NOT money-at-
// risk. Anything else is unexpected and must be escalated (DLQ + staff alert).
const EXPECTED_TRANSITION_ERRORS = new Set([
  "ConcurrencyError",
  "InvalidTransitionError",
]);

function isExpectedTransitionError(err: unknown): boolean {
  return (
    err instanceof Error && EXPECTED_TRANSITION_ERRORS.has(err.name)
  );
}

export async function startPaymentLifecycleSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  const orderCmdSvc = createOrderCommandService();
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
    // claim so redelivery reprocesses; a Redis error while claiming fails CLOSED
    // (DedupUnavailableError) so the event is left for redelivery rather than
    // processed unguarded.
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
        case PaymentStatus.PAID: {
          // Only auto-confirm for electronic payments (PIX/card).
          // Cash orders are confirmed via admin workflow.
          if (method === "cash") break;

          const order = await orderQuerySvc.getById(orderId);
          if (!order) break;

          // Only advance pending → confirmed
          if (order.fulfillmentStatus !== "pending") {
            log?.info(
              { orderId, fulfillmentStatus: order.fulfillmentStatus },
              "[payment-lifecycle] Order not pending — skipping auto-confirm",
            );
            break;
          }

          try {
            await orderCmdSvc.transitionStatus(orderId, {
              newStatus: OrderFulfillmentStatus.CONFIRMED,
              actor: "system",
              reason: "Pagamento confirmado",
            });

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
            if (isExpectedTransitionError(err)) {
              // ConcurrencyError / InvalidTransitionError — another process (or a
              // prior delivery) already advanced the order. Benign, info-level.
              log?.info(
                { orderId, error: String(err) },
                "[payment-lifecycle] Auto-confirm skipped — order already advanced",
              );
            } else {
              // Unexpected: money was taken but the order was NOT confirmed and
              // nobody is watching. Escalate like the disputed branch (DLQ + staff
              // alert) instead of silently warn-logging.
              log?.error(
                { orderId, paymentId, error: String(err) },
                "[payment-lifecycle] Auto-confirm FAILED unexpectedly — escalating",
              );
              await pushToDlq("payment.status_changed", payload as Record<string, unknown>, err, log);
              await publishNatsEvent("order.escalation_needed", {
                eventType: "order.escalation_needed",
                orderId,
                reason: "auto_confirm_failed",
                paymentId,
                timestamp: new Date().toISOString(),
              });
            }
          }
          break;
        }

        // ── Payment refunded on pending/confirmed → cancel order ──────────
        case PaymentStatus.REFUNDED: {
          const order = await orderQuerySvc.getById(orderId);
          if (!order) break;

          const cancelable = [
            OrderFulfillmentStatus.PENDING,
            OrderFulfillmentStatus.CONFIRMED,
          ] as string[];

          if (!cancelable.includes(order.fulfillmentStatus)) {
            log?.info(
              { orderId, fulfillmentStatus: order.fulfillmentStatus },
              "[payment-lifecycle] Order past cancelable state — skipping auto-cancel on refund",
            );
            break;
          }

          try {
            await orderCmdSvc.transitionStatus(orderId, {
              newStatus: OrderFulfillmentStatus.CANCELED,
              actor: "system",
              reason: "Pagamento reembolsado",
            });

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
            if (isExpectedTransitionError(err)) {
              // ConcurrencyError / InvalidTransitionError — order already moved on.
              log?.info(
                { orderId, error: String(err) },
                "[payment-lifecycle] Auto-cancel skipped — order already advanced",
              );
            } else {
              // Unexpected: money was refunded but the order was NOT canceled.
              // Escalate (DLQ + staff alert) like the disputed branch.
              log?.error(
                { orderId, paymentId, error: String(err) },
                "[payment-lifecycle] Auto-cancel after refund FAILED unexpectedly — escalating",
              );
              await pushToDlq("payment.status_changed", payload as Record<string, unknown>, err, log);
              await publishNatsEvent("order.escalation_needed", {
                eventType: "order.escalation_needed",
                orderId,
                reason: "refund_cancel_failed",
                paymentId,
                timestamp: new Date().toISOString(),
              });
            }
          }
          break;
        }

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

    // processed === false means the event was a duplicate (already confirmed)
    // OR the dedup claim could not be made and withDedup threw DedupUnavailableError
    // (which propagates above and is routed to the DLQ). A plain `false` here is
    // therefore always a benign duplicate skip.
    if (!processed) {
      log?.info({ paymentId, newStatus }, "[payment-lifecycle] duplicate — skipping");
    }
  });

  log?.info("[payment-lifecycle] Subscriber started");
}
