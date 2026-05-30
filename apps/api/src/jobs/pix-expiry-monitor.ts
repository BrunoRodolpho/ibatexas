// PIX expiry monitor — sends reminders before PIX QR codes expire
// and offers regeneration after expiry.
//
// Flow:
// 1. After PIX QR is generated, agent.ts schedules two delayed jobs:
//    a) REMINDER at 25 min — "Seu QR PIX expira em 5 minutos!"
//    b) EXPIRED at 30 min — "O PIX expirou. Quer que eu gere um novo?"
// 2. Each job checks if payment was already confirmed (Redis key set by stripe webhook)
// 3. If paid → skip. If not → send message.

import * as Sentry from "@sentry/node";
import { getRedisClient, rk, medusaAdmin } from "@ibatexas/tools";
import { createPaymentQueryService } from "@ibatexas/domain";
import { PaymentStatus } from "@ibatexas/types";
import type { Queue, Worker } from "bullmq";
import { sendText } from "../whatsapp/client.js";
import logger from "../lib/logger.js";
import { createQueue, createWorker, type Job } from "./queue.js";

const PIX_REMINDER_DELAY_MS = Number.parseInt(
  process.env.PIX_REMINDER_DELAY_MS || "1500000", // 25 minutes
  10,
);
const PIX_EXPIRED_DELAY_MS = Number.parseInt(
  process.env.PIX_EXPIRED_DELAY_MS || "1800000", // 30 minutes
  10,
);
// P3-NET-PIXREMINDER: TTL (seconds) for the per-stage "already sent" idempotency
// key. BullMQ schedules these jobs with removeOnComplete, so a retry re-runs the
// processor and would re-send the WhatsApp message. The NX key suppresses the
// duplicate send. TTL only needs to outlive the job's retry window; default 1h
// comfortably covers the 25/30-min schedule plus any backoff.
const PIX_REMINDER_SENT_TTL_SECONDS = Number.parseInt(
  process.env.PIX_REMINDER_SENT_TTL_SECONDS || "3600", // 1 hour
  10,
);

export interface PixExpiryJobData {
  phone: string;
  phoneHash: string;
  orderId: string;
  stage: "reminder" | "expired";
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  queue ??= createQueue("pix-expiry-monitor");
  return queue;
}

/** Check if PIX payment was already confirmed (stripe webhook sets this key). */
export async function isPixPaid(orderId: string): Promise<boolean> {
  const redis = await getRedisClient();
  const paid = await redis.get(rk(`pix:paid:${orderId}`));
  if (paid) return true;

  // PIXPAIDFLAG: the Redis flag is best-effort — markPixPaid runs AFTER the DB write
  // and is catch-and-ignored on failure (stripe-webhook-processor handlePaymentSucceeded),
  // and the key carries a 2h TTL. If it is absent, confirm against the Payment projection
  // (the billing source of truth) so a customer who already paid never gets a spurious
  // "your PIX expired" message. Pure added read; no money movement.
  try {
    const payment = await createPaymentQueryService().getActiveByOrderId(orderId);
    return payment?.status === PaymentStatus.PAID;
  } catch {
    // DB unavailable — preserve the unpaid default (a stray reminder is harmless).
    return false;
  }
}

/** BullMQ processor — sends reminder or expiry message if PIX is unpaid. */
export async function processPixExpiry(job: Job<PixExpiryJobData>): Promise<void> {
  const { phone, orderId, stage } = job.data;

  // Skip if already paid
  if (await isPixPaid(orderId)) return;

  // P3-NET-PIXREMINDER: per-stage idempotency around the message send. Jobs are
  // scheduled with removeOnComplete, so a retry re-runs this processor; without
  // a guard the customer gets a duplicate reminder/expiry WhatsApp. Claim the
  // send with SET NX (first runner wins); a null reply means another run already
  // sent this {orderId,stage}, so skip. This wraps ONLY the message send — the
  // isPixPaid() paid-check and all payment logic above are untouched.
  const redis = await getRedisClient();
  const claimed = await redis.set(
    rk(`pix:reminder-sent:${orderId}:${stage}`),
    "1",
    { NX: true, EX: PIX_REMINDER_SENT_TTL_SECONDS },
  );
  if (!claimed) return;

  if (stage === "reminder") {
    await sendText(
      `whatsapp:${phone}`,
      "Seu QR PIX expira em 5 minutos! Ainda dá tempo de escanear 🍖",
    );
  } else {
    // Check if this is a scheduled-pickup order — send a tailored message
    let isScheduledPickup = false;
    try {
      const orderData = (await medusaAdmin(`/admin/orders/${orderId}`)) as {
        order?: { metadata?: Record<string, string> };
      };
      isScheduledPickup = orderData.order?.metadata?.["scheduledPickup"] === "true";
    } catch {
      // If we can't fetch the order, fall through to the generic message
    }

    if (isScheduledPickup) {
      await sendText(
        `whatsapp:${phone}`,
        "Seu PIX expirou, mas o pedido tá salvo! Manda 'novo pix' que gero outro, ou pode pagar em dinheiro/cartão na retirada.",
      );
    } else {
      await sendText(
        `whatsapp:${phone}`,
        "O PIX expirou, mas seu pedido tá salvo. Quer que eu gere um novo QR?",
      );
    }
  }
}

/** Schedule both PIX expiry jobs after a PIX QR is generated. */
export async function schedulePixExpiryMonitor(
  data: Omit<PixExpiryJobData, "stage">,
): Promise<void> {
  const q = getQueue();
  await Promise.all([
    q.add("pix-reminder", { ...data, stage: "reminder" as const }, {
      delay: PIX_REMINDER_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: true,
    }),
    q.add("pix-expired", { ...data, stage: "expired" as const }, {
      delay: PIX_EXPIRED_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: true,
    }),
  ]);
}

/** Mark a PIX payment as confirmed (called from stripe webhook). */
export async function markPixPaid(orderId: string): Promise<void> {
  const redis = await getRedisClient();
  // TTL 2h — plenty of time for any pending jobs to check
  await redis.set(rk(`pix:paid:${orderId}`), "1", { EX: 7200 });
}

export function startPixExpiryMonitor(): void {
  if (worker) return;
  worker = createWorker("pix-expiry-monitor", processPixExpiry);

  // Jobs are scheduled with removeOnFail, so a processor failure (e.g. a failed
  // reminder/expiry send) would otherwise vanish silently. Make it observable.
  worker.on("failed", (job, err) => {
    logger.error(
      { err, job: "pix-expiry-monitor", stage: job?.data?.stage },
      "[pix-expiry-monitor] job failed",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", "pix-expiry-monitor");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });
}

export async function stopPixExpiryMonitor(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
