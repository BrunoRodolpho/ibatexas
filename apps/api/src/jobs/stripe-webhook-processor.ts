// Stripe webhook processor — durable ack-then-async execution of Stripe events.
//
// ── P1-NET-STRIPESYNC (audit e605211) ─────────────────────────────────────────
//
// The Stripe webhook route used to run all heavy money work (Medusa cart
// completion, capture, NATS publishes, reconciliation) INLINE before returning
// 200. A slow Medusa/DB call held the HTTP connection open and risked a Stripe
// client-side timeout → retry storm + duplicate processing. Now the route
// verifies the signature, claims the idempotency key, and ENQUEUES a durable
// BullMQ job, returning 200 immediately. This module owns the queue + worker.
//
// Durability contract (the "bad-money-port trap"): because the route returns 200
// after enqueue, Stripe will NOT retry — so durability rests on BullMQ, not
// Stripe. Therefore:
//   • jobId = event.id  → BullMQ-level dedup across re-deliveries.
//   • attempts + exponential backoff → transient processing failures retry.
//   • failed jobs are RETAINED (removeOnFail inherits the factory's {count:500})
//     + surfaced to Sentry via the "failed" listener for ops replay.
//   • If the ENQUEUE ITSELF fails, the route downgrades the idempotency key TTL
//     to 300s + returns 500 so Stripe re-delivers — order completion is never
//     lost behind a claimed key (handled in the route, not here).
//
// The event handlers stay in routes/stripe-webhook.ts (kernel-adjudicated, with
// the P0-PAY-1/P0-PAY-2/PIXDUP/STRIPESRC fixes) and are injected here as a
// `dispatch` callback — this module is generic queue/worker plumbing with no
// knowledge of the handlers, which keeps the dependency one-directional (route →
// processor) and avoids a route↔processor import cycle.

import * as Sentry from "@sentry/node";
import type Stripe from "stripe";
import type { Queue, Worker } from "bullmq";
import logger from "../lib/logger.js";
import { createQueue, createWorker, type Job } from "./queue.js";

const QUEUE_NAME = "stripe-webhook";

// Durable-retry knobs (Hard Rule #3 — env-configurable).
const JOB_ATTEMPTS = Number.parseInt(process.env.STRIPE_WEBHOOK_JOB_ATTEMPTS || "5", 10);
const JOB_BACKOFF_MS = Number.parseInt(process.env.STRIPE_WEBHOOK_JOB_BACKOFF_MS || "5000", 10);

export interface StripeWebhookJobData {
  event: Stripe.Event;
  /** Epoch ms when the webhook was received — drives end-to-end processing_ms logs. */
  receivedAtMs: number;
}

/** Logger shape the injected dispatch expects (pino + Fastify both satisfy it). */
type WebhookLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type StripeWebhookDispatch = (
  event: Stripe.Event,
  receivedAtMs: number,
  log: WebhookLogger,
) => Promise<void>;

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  queue ??= createQueue(QUEUE_NAME);
  return queue;
}

/**
 * Enqueue a (signature-verified) Stripe event for durable async processing.
 * Returns once the job is durably persisted to Redis. Throws if the enqueue
 * itself fails — the caller (route) downgrades the idempotency key + returns 500
 * so Stripe re-delivers rather than losing the event behind a claimed key.
 *
 * `jobId = event.id` makes the add idempotent at the BullMQ layer: a re-delivered
 * event (same id) is a no-op add, so the heavy work runs at most once even if the
 * route's Redis idempotency claim was lost.
 */
export async function enqueueStripeWebhookEvent(
  event: Stripe.Event,
  receivedAtMs: number,
): Promise<void> {
  await getQueue().add(
    event.type,
    { event, receivedAtMs } satisfies StripeWebhookJobData,
    {
      jobId: event.id,
      attempts: JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: JOB_BACKOFF_MS },
      removeOnComplete: true,
      // removeOnFail NOT set → inherits the factory's {count:500} retention so a
      // permanently-failing money event survives for ops replay/triage.
    },
  );
}

/**
 * Start the worker that drains queued Stripe events through the injected
 * `dispatch` (the route's handler switch). Idempotent. The createWorker factory
 * already attaches a default "error" listener (connection-level failures, never
 * rethrows — P1-ERR-WORKERLISTENERS); here we add a "failed" listener so a
 * permanently-failing job (attempts exhausted) is surfaced to Sentry + retained.
 */
export function startStripeWebhookProcessor(dispatch: StripeWebhookDispatch): void {
  if (worker) return;
  getQueue();
  worker = createWorker(QUEUE_NAME, async (job: Job) => {
    const { event, receivedAtMs } = job.data as StripeWebhookJobData;
    await dispatch(event, receivedAtMs, logger);
  });

  worker.on("failed", (job, err) => {
    const data = job?.data as StripeWebhookJobData | undefined;
    logger.error(
      {
        err,
        job: QUEUE_NAME,
        event_id: data?.event?.id,
        event_type: data?.event?.type,
        attemptsMade: job?.attemptsMade,
      },
      "[stripe-webhook] job failed — retained for replay",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", QUEUE_NAME);
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });
}

export async function stopStripeWebhookProcessor(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
