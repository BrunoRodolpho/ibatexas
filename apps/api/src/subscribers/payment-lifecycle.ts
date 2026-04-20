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
import { getRedisClient, rk } from "@ibatexas/tools";
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
import { isNewEvent } from "./dedup.js";

export async function startPaymentLifecycleSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  const orderCmdSvc = createOrderCommandService();
  const orderQuerySvc = createOrderQueryService();
  const eventLogSvc = createOrderEventLogService(log);

  await subscribeNatsEvent("payment.status_changed", async (payload) => {
    const event = payload as unknown as PaymentStatusChangedEvent & { eventType?: string };
    const { orderId, paymentId, newStatus, method } = event;

    // Idempotency guard
    try {
      if (!(await isNewEvent(`payment-lifecycle:${paymentId}:${newStatus}`))) {
        log?.info({ paymentId, newStatus }, "[payment-lifecycle] duplicate — skipping");
        return;
      }
    } catch { /* dedup failure is non-fatal */ }

    log?.info(
      { orderId, paymentId, newStatus, method },
      "[payment-lifecycle] payment.status_changed received",
    );

    try {
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
            // ConcurrencyError or InvalidTransitionError — another process may have done it
            log?.warn(
              { orderId, error: String(err) },
              "[payment-lifecycle] Failed to auto-confirm order — may already be advanced",
            );
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
            log?.warn(
              { orderId, error: String(err) },
              "[payment-lifecycle] Failed to cancel order after refund",
            );
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
    } catch (err) {
      log?.error(
        { orderId, paymentId, newStatus, error: String(err) },
        "[payment-lifecycle] Error handling payment status change",
      );
    }
  });

  log?.info("[payment-lifecycle] Subscriber started");
}
