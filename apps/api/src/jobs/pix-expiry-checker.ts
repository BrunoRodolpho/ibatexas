// PIX expiry checker
// Runs every 5 minutes via BullMQ repeatable job.
// Queries Medusa for pending orders older than PIX_EXPIRY_MINUTES (default 30).
// For each expired PIX order: cancels via Medusa admin and publishes "payment.pix_expired".

import { medusaAdmin, MedusaRequestError, cancelStalePaymentIntent } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface MedusaOrderListResponse {
  orders?: Array<{
    id: string;
    status: string;
    created_at: string;
    metadata?: Record<string, string>;
  }>;
}

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

function getPixExpiryMs(): number {
  const minutes = Number(process.env.PIX_EXPIRY_MINUTES) || 30;
  return minutes * 60 * 1000;
}

/** Core job logic — exported for direct testing. */
export async function checkPixExpiry(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger;
  const expiryMs = getPixExpiryMs();
  const cutoffDate = new Date(Date.now() - expiryMs).toISOString();
  let expiredCount = 0;

  try {
    // Query Medusa for pending orders created before the cutoff
    const data = (await medusaAdmin(
      `/admin/orders?status=pending&created_at[lt]=${encodeURIComponent(cutoffDate)}&limit=50`,
    )) as MedusaOrderListResponse;

    const orders = data.orders ?? [];

    for (const order of orders) {
      try {
        // Don't cancel orders with scheduled pickup — PIX can be regenerated
        if (order.metadata?.["scheduledPickup"] === "true") {
          // Just cancel the Stripe PI (prevent stale QR usage) but keep the Medusa order
          const piId = order.metadata?.["stripePaymentIntentId"];
          if (piId) {
            await cancelStalePaymentIntent(piId);
          }
          effectiveLogger?.info({ order_id: order.id }, "Skipped cancel for scheduled-pickup order (PIX expired but order preserved)");
          continue; // skip order cancellation
        }

        // Cancel the expired order via Medusa
        await medusaAdmin(`/admin/orders/${order.id}/cancel`, { method: "POST" });

        // Cancel the Stripe PaymentIntent to prevent late PIX scans
        const piId = order.metadata?.["stripePaymentIntentId"];
        if (piId) {
          await cancelStalePaymentIntent(piId);
        }

        await publishNatsEvent("payment.pix_expired", {
          eventType: "payment.pix_expired",
          orderId: order.id,
          customerId: order.metadata?.["customerId"],
          createdAt: order.created_at,
        });

        expiredCount++;
        effectiveLogger?.info({ order_id: order.id }, "[pix-expiry] Order cancelled — PIX expired");
      } catch (err) {
        effectiveLogger?.error(
          { order_id: order.id, error: String(err) },
          "[pix-expiry] Error processing expired order",
        );
        Sentry.withScope((scope) => {
          scope.setTag("job", "pix-expiry-checker");
          scope.setTag("source", "background-job");
          scope.setContext("order", { orderId: order.id });
          Sentry.captureException(err);
        });
      }
    }
  } catch (err) {
    if (err instanceof MedusaRequestError && err.statusCode === 401) {
      effectiveLogger?.error(
        "[pix-expiry] Medusa returned 401 Unauthorized — check MEDUSA_API_KEY is set and valid",
      );
    } else {
      effectiveLogger?.error({ error: String(err) }, "[pix-expiry] Error querying pending orders");
    }
    Sentry.withScope((scope) => {
      scope.setTag("job", "pix-expiry-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  }

  effectiveLogger?.info(
    { expired_count: expiredCount, run_at: new Date().toISOString() },
    "PIX expiry check complete",
  );
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
