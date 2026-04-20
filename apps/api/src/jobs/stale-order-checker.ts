// Stale order checker — cancels unpaid orders after a configurable threshold.
//
// Runs every 30 minutes via BullMQ repeatable job.
// Queries OrderProjection for `pending` orders whose current payment is NOT
// `paid` or `cash_pending`, and whose creation time exceeds the threshold.
//
// Env vars:
//   STALE_ORDER_THRESHOLD_HOURS=24        (default)
//   STALE_ORDER_DRY_RUN=false             (safety: log but don't cancel)
//
// Exclusions:
//   - Cash orders with `cash_pending` payment (payment expected at delivery)
//   - Orders with `paid` payment status (already paid)
//
// INVARIANT: This is the ONLY job that cancels orders due to payment inactivity.
// PIX expiry checker only transitions payment status, never cancels orders.

import { withLock } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  prisma,
  createOrderCommandService,
  createPaymentCommandService,
} from "@ibatexas/domain";
import {
  OrderFulfillmentStatus,
  PaymentStatus,
  type OrderCanceledEvent,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

function getThresholdMs(): number {
  const hours = Number(process.env.STALE_ORDER_THRESHOLD_HOURS) || 24;
  return hours * 60 * 60 * 1000;
}

function isDryRun(): boolean {
  return process.env.STALE_ORDER_DRY_RUN === "true";
}

/** Core job logic — exported for direct testing. */
export async function checkStaleOrders(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger;
  const thresholdMs = getThresholdMs();
  const cutoff = new Date(Date.now() - thresholdMs);
  const dryRun = isDryRun();
  let canceledCount = 0;

  try {
    // Find pending orders older than threshold, joined with their current payment
    const staleOrders = await prisma.orderProjection.findMany({
      where: {
        fulfillmentStatus: "pending",
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        displayId: true,
        customerId: true,
        currentPaymentId: true,
        payments: {
          where: {
            status: { notIn: ["refunded", "canceled", "waived", "payment_failed", "payment_expired"] },
          },
          select: { id: true, status: true, version: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      take: 50,
    });

    const orderCmdSvc = createOrderCommandService();
    const paymentCmdSvc = createPaymentCommandService(effectiveLogger ?? undefined);

    for (const order of staleOrders) {
      try {
        const activePayment = order.payments[0];

        // Skip if payment is already captured or is cash_pending (waiting for delivery)
        if (activePayment) {
          const status = activePayment.status as string;
          if (status === "paid" || status === "cash_pending") {
            continue;
          }
        }

        if (dryRun) {
          effectiveLogger?.info(
            { orderId: order.id, displayId: order.displayId, paymentStatus: activePayment?.status ?? "none" },
            "[stale-order] DRY RUN — would cancel",
          );
          continue;
        }

        // Acquire lock on the order to prevent concurrent cancellation
        const result = await withLock(`order:${order.id}`, async () => {
          // Cancel the order fulfillment
          try {
            await orderCmdSvc.transitionStatus(order.id, {
              newStatus: OrderFulfillmentStatus.CANCELED,
              actor: "system",
              reason: "Pedido expirado — pagamento não confirmado",
            });
          } catch (err) {
            // Already canceled or invalid transition — skip
            if ((err as Error).name === "InvalidTransitionError") return false;
            throw err;
          }

          // Cancel the active payment if one exists
          if (activePayment) {
            try {
              const transition = await paymentCmdSvc.transitionStatus(activePayment.id, {
                newStatus: PaymentStatus.CANCELED,
                actor: "system",
                reason: "Pedido expirado",
                expectedVersion: activePayment.version,
              });

              await publishNatsEvent("payment.status_changed", {
                eventType: "payment.status_changed",
                orderId: order.id,
                paymentId: activePayment.id,
                previousStatus: activePayment.status,
                newStatus: PaymentStatus.CANCELED,
                method: "unknown",
                version: transition.version,
                timestamp: new Date().toISOString(),
              } satisfies PaymentStatusChangedEvent & { eventType: string });
            } catch {
              // Payment may already be terminal — non-critical
            }
          }

          // Publish order.canceled
          await publishNatsEvent("order.canceled", {
            eventType: "order.canceled",
            orderId: order.id,
            displayId: order.displayId,
            customerId: order.customerId ?? null,
            reason: "Pedido expirado — pagamento não confirmado",
            canceledBy: "system",
            timestamp: new Date().toISOString(),
          });

          return true;
        }, 15);

        if (result) {
          canceledCount++;
          effectiveLogger?.info(
            { orderId: order.id, displayId: order.displayId },
            "[stale-order] Order canceled — payment not confirmed within threshold",
          );
        }
      } catch (err) {
        effectiveLogger?.error(
          { orderId: order.id, error: String(err) },
          "[stale-order] Error processing stale order",
        );
        Sentry.withScope((scope) => {
          scope.setTag("job", "stale-order-checker");
          scope.setTag("source", "background-job");
          scope.setContext("order", { orderId: order.id });
          Sentry.captureException(err);
        });
      }
    }
  } catch (err) {
    effectiveLogger?.error({ error: String(err) }, "[stale-order] Error querying stale orders");
    Sentry.withScope((scope) => {
      scope.setTag("job", "stale-order-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  }

  effectiveLogger?.info(
    { canceled_count: canceledCount, dry_run: isDryRun(), run_at: new Date().toISOString() },
    "Stale order check complete",
  );
}

/** BullMQ processor. */
async function processor(_job: Job): Promise<void> {
  await checkStaleOrders();
}

export function startStaleOrderChecker(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("stale-order-checker");
  worker = createWorker("stale-order-checker", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[stale-order-checker] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "stale-order-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  void queue.upsertJobScheduler("stale-order-repeat", {
    every: REPEAT_INTERVAL_MS,
  });
}

export async function stopStaleOrderChecker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
