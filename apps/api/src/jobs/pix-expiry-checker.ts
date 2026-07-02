// PIX expiry checker — Payment-aware version.
//
// Runs every 5 minutes via BullMQ repeatable job.
// Queries the Payment table for `payment_pending` PIX payments past their pixExpiresAt.
// For each: acquires distributed lock, transitions to `payment_expired`,
// cancels the Stripe PaymentIntent, and publishes `payment.status_changed`.
//
// INVARIANT: This job NEVER cancels orders. It only transitions payment status.
// Order cleanup is handled by the separate stale-order-checker job.
//
// ── Task 16 (M3) — kernel-gated PIX expiry ────────────────────────────────
//
// Per investigation 04 P0 #2 (paired with stale-order-checker): autonomous
// payment-state mutation by wall clock. Now flows through an envelope of
// kind `payment.status.transition` (SYSTEM-only at the policy bundle's
// taint floor). nonce = `pix:expiry:${paymentId}` for deterministic replay.

import { cancelStalePaymentIntent, withLock } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createPaymentCommandService,
  prisma,
  type PaymentStatusTransitionPayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { PaymentStatus, type PaymentStatusChangedEvent } from "@ibatexas/types";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";

const REPEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** Core job logic — exported for direct testing. */
export async function checkPixExpiry(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger;
  const paymentSvc = createPaymentCommandService(effectiveLogger ?? undefined, {
    auditSink: getAuditSink(),
  });
  let expiredCount = 0;

  try {
    // Query Payment rows: PIX method, payment_pending, pixExpiresAt in the past
    const expiredPayments = await prisma.payment.findMany({
      where: {
        method: "pix",
        status: "payment_pending",
        pixExpiresAt: { lt: new Date() },
      },
      select: {
        id: true,
        orderId: true,
        stripePaymentIntentId: true,
        version: true,
      },
      take: 50,
    });

    for (const payment of expiredPayments) {
      try {
        // Acquire distributed lock on this payment
        const result = await withLock(`payment:${payment.id}`, async () => {
          // ── Task 16: kernel-gated payment transition ────────────────
          const transitionPayload: PaymentStatusTransitionPayload = {
            paymentId: payment.id,
            newStatus: PaymentStatus.PAYMENT_EXPIRED,
            actor: "system",
            reason: "PIX expirado",
            expectedVersion: payment.version,
          };
          const envelope = buildSystemEnvelope({
            kind: "payment.status.transition" as const,
            payload: transitionPayload,
            sourceSubject: "pix-expiry-checker",
            eventId: `pix:expiry:${payment.id}`,
          });

          const outcome = await paymentSvc.transitionStatusFromEnvelope(envelope);
          if (
            outcome.decision.kind !== "EXECUTE" &&
            outcome.decision.kind !== "REWRITE"
          ) {
            const refusalCode =
              outcome.decision.kind === "REFUSE"
                ? outcome.decision.refusal.code
                : undefined;
            effectiveLogger?.warn(
              { paymentId: payment.id, decision: outcome.decision.kind, refusalCode },
              "[pix-expiry] kernel did not authorize transition — skipping",
            );
            return false;
          }
          const transition = outcome.result!;

          // Cancel the Stripe PaymentIntent to prevent late PIX scans
          if (payment.stripePaymentIntentId) {
            try {
              await cancelStalePaymentIntent(payment.stripePaymentIntentId);
            } catch (piErr) {
              // PI may already be canceled or in a non-cancelable state — log and continue
              effectiveLogger?.warn(
                { paymentId: payment.id, piId: payment.stripePaymentIntentId, error: String(piErr) },
                "[pix-expiry] Failed to cancel Stripe PI — continuing",
              );
            }
          }

          // Publish payment.status_changed event
          await publishNatsEvent("payment.status_changed", {
            eventType: "payment.status_changed",
            orderId: payment.orderId,
            paymentId: payment.id,
            previousStatus: transition.previousStatus,
            newStatus: transition.newStatus,
            method: "pix",
            version: transition.version,
            timestamp: new Date().toISOString(),
          } satisfies PaymentStatusChangedEvent & { eventType: string });

          return true;
        }, 10);

        if (result === null) {
          // Lock not acquired — another process is handling this payment
          effectiveLogger?.debug(
            { component: "job.pix-expiry", event: "lock_skip", paymentId: payment.id },
            "[pix-expiry] Lock not acquired — skipping (will retry next run)",
          );
          continue;
        }

        if (result === false) {
          // Kernel refused / payment already transitioned
          continue;
        }

        expiredCount++;
        effectiveLogger?.info(
          { component: "job.pix-expiry", event: "expired", paymentId: payment.id, orderId: payment.orderId },
          "[pix-expiry] Payment expired — order preserved for retry/method switch",
        );
      } catch (err) {
        // InvalidPaymentTransitionError means it was already transitioned — safe to skip
        if ((err as Error).name === "InvalidPaymentTransitionError") {
          effectiveLogger?.debug(
            { component: "job.pix-expiry", event: "already_transitioned", paymentId: payment.id },
            "[pix-expiry] Payment already transitioned — skipping",
          );
          continue;
        }
        // PaymentConcurrencyError means version changed — will retry next run
        if ((err as Error).name === "PaymentConcurrencyError") {
          effectiveLogger?.debug(
            { component: "job.pix-expiry", event: "concurrency_conflict", paymentId: payment.id },
            "[pix-expiry] Concurrency conflict — will retry next run",
          );
          continue;
        }

        effectiveLogger?.error(
          { paymentId: payment.id, error: String(err) },
          "[pix-expiry] Error processing expired payment",
        );
        Sentry.withScope((scope) => {
          scope.setTag("job", "pix-expiry-checker");
          scope.setTag("source", "background-job");
          scope.setContext("payment", { paymentId: payment.id, orderId: payment.orderId });
          Sentry.captureException(err);
        });
      }
    }
  } catch (err) {
    effectiveLogger?.error({ error: String(err) }, "[pix-expiry] Error querying expired payments");
    Sentry.withScope((scope) => {
      scope.setTag("job", "pix-expiry-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  }

  // NOISE-4: log only when payments actually expired (most sweeps expire 0).
  if (expiredCount > 0) {
    effectiveLogger?.info(
      { component: "job.pix-expiry", event: "sweep", expired_count: expiredCount },
      "PIX expiry sweep expired payments",
    );
  }
}

/** BullMQ processor — wraps the core logic. */
async function processor(_job: Job): Promise<void> {
  await checkPixExpiry();
}

export function startPixExpiryChecker(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("pix-expiry-checker");
  worker = createWorker("pix-expiry-checker", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[pix-expiry-checker] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "pix-expiry-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Add repeatable job (idempotent — BullMQ deduplicates by repeat key)
  void queue.upsertJobScheduler("pix-expiry-repeat", {
    every: REPEAT_INTERVAL_MS,
  });
}

export async function stopPixExpiryChecker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
