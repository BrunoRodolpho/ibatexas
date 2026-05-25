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

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderQueryService,
  createOrderEventLogService,
  type OrderStatusTransitionPayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/llm-provider";
import {
  OrderFulfillmentStatus,
  PaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import type { FastifyBaseLogger } from "fastify";
import { isNewEvent } from "./dedup.js";
import { pushToDlq } from "./dlq.js";
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js";

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
                "[payment-lifecycle] kernel did not authorize auto-confirm — mutation skipped",
              );
              if (outcome.decision.kind === "REFUSE") {
                await pushToDlq(
                  "payment.status_changed",
                  payload as Record<string, unknown>,
                  `kernel REFUSE: ${outcome.decision.refusal.code}`,
                  log,
                );
              }
              break;
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
            // P1-C: transitionStatusFromEnvelope threw (ConcurrencyError,
            // InvalidTransitionError, kernel circuit-open, etc.). Previously
            // we logged a warn and swallowed — the original NATS payload
            // evaporated with no operator surface. Push to DLQ so ops can
            // replay or triage; the dedup ledger keyed on
            // (paymentId, newStatus) protects against re-firing the
            // mutation if the replay turns into an EXECUTE.
            log?.error(
              { orderId, paymentId, error: String(err) },
              "[payment-lifecycle] Failed to auto-confirm order — pushing to DLQ",
            );
            await pushToDlq(
              "payment.status_changed",
              payload as Record<string, unknown>,
              err,
              log,
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
              outcome.decision.kind !== "EXECUTE" &&
              outcome.decision.kind !== "REWRITE"
            ) {
              const decisionKind = outcome.decision.kind;
              const refusalCode =
                outcome.decision.kind === "REFUSE"
                  ? outcome.decision.refusal.code
                  : undefined;
              log?.warn(
                { orderId, paymentId, decision: decisionKind, refusalCode },
                "[payment-lifecycle] kernel did not authorize auto-cancel — mutation skipped",
              );
              if (outcome.decision.kind === "REFUSE") {
                await pushToDlq(
                  "payment.status_changed",
                  payload as Record<string, unknown>,
                  `kernel REFUSE: ${outcome.decision.refusal.code}`,
                  log,
                );
              }
              break;
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
            // P1-C: same fail-safety as the auto-confirm path above. The
            // original NATS payload survives in the DLQ for ops replay
            // rather than evaporating into the warn log.
            log?.error(
              { orderId, paymentId, error: String(err) },
              "[payment-lifecycle] Failed to cancel order after refund — pushing to DLQ",
            );
            await pushToDlq(
              "payment.status_changed",
              payload as Record<string, unknown>,
              err,
              log,
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
  }, { queueGroup: "payment-lifecycle" });

  log?.info("[payment-lifecycle] Subscriber started");
}
