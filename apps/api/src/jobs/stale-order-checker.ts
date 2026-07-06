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
//
// ── Task 16 (M3) — kernel-gated stale cancel ──────────────────────────────
//
// Per investigation 04 P0 #2: this cron job mutates order + payment state
// autonomously under Redis locks. A forged BullMQ tick today could fan out
// arbitrary cancellations. Both transitions (order → CANCELED, payment →
// CANCELED) now flow through SYSTEM-actor IntentEnvelopes:
//
//   - order.status.transition  (orderCmdSvc.transitionStatusFromEnvelope)
//   - payment.status.transition (paymentCmdSvc.transitionStatusFromEnvelope)
//
// Per-candidate envelopes carry a deterministic nonce (`stale:${orderId}`
// for the order, `stale:${paymentId}` for the payment) so a re-run of the
// job (or a duplicate BullMQ delivery) produces a byte-identical envelope
// and the kernel / ledger can dedupe.

import { withLock } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  prisma,
  createOrderCommandService,
  createPaymentCommandService,
  createOpsAlertService,
  OPS_ALERT_CAUSE_LABELS_PT,
  type OrderStatusTransitionPayload,
  type PaymentStatusTransitionPayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { parseBoolEnv } from "@ibatexas/types";
import {
  OrderFulfillmentStatus,
  PaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";
import { createQueue, createWorker, type Job } from "./queue.js";
import { reconcileSweepOpsAlert, sweepCountSeverity } from "./ops-alert-reconcile.js";

const REPEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

function getThresholdMs(): number {
  const hours = Number(process.env.STALE_ORDER_THRESHOLD_HOURS) || 24;
  return hours * 60 * 60 * 1000;
}

function isDryRun(): boolean {
  // NEW-P1-ENV: was `=== "true"` — operator setting `=1` or `=TRUE`
  // would silently land on the destructive path. parseBoolEnv accepts
  // the canonical truthy lexicon and defaults to false (production-safe).
  return parseBoolEnv(process.env.STALE_ORDER_DRY_RUN, false);
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

    const auditSink = getAuditSink();
    const orderCmdSvc = createOrderCommandService(effectiveLogger ?? undefined, {
      auditSink,
    });
    const paymentCmdSvc = createPaymentCommandService(effectiveLogger ?? undefined, {
      auditSink,
    });

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
          // ── Task 16: kernel-gated order cancel ──────────────────────
          const orderTransitionPayload: OrderStatusTransitionPayload = {
            orderId: order.id,
            newStatus: OrderFulfillmentStatus.CANCELED,
            actor: "system",
            reason: "Pedido expirado — pagamento não confirmado",
          };
          const orderEnvelope = buildSystemEnvelope({
            kind: "order.status.transition" as const,
            payload: orderTransitionPayload,
            sourceSubject: "stale-order-checker",
            eventId: `stale:${order.id}`,
          });

          try {
            const outcome = await orderCmdSvc.transitionStatusFromEnvelope(orderEnvelope);
            if (
              outcome.decision.kind !== "EXECUTE" &&
              outcome.decision.kind !== "REWRITE"
            ) {
              const refusalCode =
                outcome.decision.kind === "REFUSE"
                  ? outcome.decision.refusal.code
                  : undefined;
              effectiveLogger?.warn(
                { orderId: order.id, decision: outcome.decision.kind, refusalCode },
                "[stale-order] kernel did not authorize order cancel — skipping",
              );
              return false;
            }
          } catch (err) {
            // Already canceled or invalid transition — skip
            if ((err as Error).name === "InvalidTransitionError") return false;
            throw err;
          }

          // ── Task 16: kernel-gated payment cancel ────────────────────
          if (activePayment) {
            const paymentTransitionPayload: PaymentStatusTransitionPayload = {
              paymentId: activePayment.id,
              newStatus: PaymentStatus.CANCELED,
              actor: "system",
              reason: "Pedido expirado",
              expectedVersion: activePayment.version,
            };
            const paymentEnvelope = buildSystemEnvelope({
              kind: "payment.status.transition" as const,
              payload: paymentTransitionPayload,
              sourceSubject: "stale-order-checker",
              eventId: `stale:${activePayment.id}`,
            });

            try {
              const outcome = await paymentCmdSvc.transitionStatusFromEnvelope(paymentEnvelope);
              if (
                outcome.decision.kind === "EXECUTE" ||
                outcome.decision.kind === "REWRITE"
              ) {
                const transition = outcome.result!;
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
              } else {
                effectiveLogger?.warn(
                  { paymentId: activePayment.id, decision: outcome.decision.kind },
                  "[stale-order] kernel did not authorize payment cancel — order already canceled",
                );
              }
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

  // BKL-080 — surface a stuck-order SPIKE to the ops-alert plane (additive; wrapped
  // so it can NEVER break the core cancellation job). A burst of stale-unpaid
  // cancellations in one sweep signals a systemic payment-completion failure (PIX
  // provider down, checkout broken). Not raised in dry-run (nothing was acted on).
  const stuckThreshold = Number(process.env.OPS_STUCK_ORDER_ALERT_THRESHOLD) || 10;
  try {
    await reconcileSweepOpsAlert({
      svc: createOpsAlertService({ auditSink: getAuditSink(), log: effectiveLogger ?? undefined }),
      over: !isDryRun() && canceledCount >= stuckThreshold,
      open: {
        cause: "ops_stuck_order",
        severity: sweepCountSeverity(canceledCount, stuckThreshold),
        source: "stale-order-checker",
        scope: null,
        title: `${OPS_ALERT_CAUSE_LABELS_PT.ops_stuck_order}: ${canceledCount} numa varredura`,
        detail: `${canceledCount} pedidos não pagos foram cancelados nesta varredura (limite ${stuckThreshold}).`,
        context: { canceledCount, threshold: stuckThreshold },
        dedupeKey: "ops_stuck_order",
      },
      sourceSubject: "stale-order-checker",
      now: Date.now(),
      log: effectiveLogger ?? undefined,
    });
  } catch (err) {
    effectiveLogger?.warn({ error: String(err) }, "[stale-order] ops-alert reconcile failed (non-fatal)");
  }
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
