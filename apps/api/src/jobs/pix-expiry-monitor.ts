// PIX expiry monitor — sends reminders before PIX QR codes expire
// and offers regeneration after expiry.
//
// Flow:
// 1. After PIX QR is generated, the WhatsApp route schedules two delayed jobs:
//    a) REMINDER at 25 min — "Seu QR PIX expira em 5 minutos!"
//    b) EXPIRED at 30 min — "O PIX expirou. Quer que eu gere um novo?"
// 2. Each job checks if payment was already confirmed (Redis key set by stripe webhook)
// 3. If paid → skip. If not → send message.
//
// ── BKL-241: the canonical id is the Stripe PaymentIntent id ────────────────
// Every id on this path — the job payload, the `pix:paid:` marker, the
// `pix:reminder-sent:` claim and the DB paid-check — is the `pi_…` id of the
// PIX ATTEMPT this monitor watches, never the Medusa order id. Two code facts
// force that choice:
//
//   • At QR-mint time there IS no order. `confirmPixAndGetQrCode`
//     (packages/tools/src/cart/create-checkout.ts) deliberately does NOT
//     complete the cart; the Medusa order is created later by
//     `completePixCartIfNeeded` on `payment_intent.succeeded`. The PI id is the
//     only id that exists on BOTH the scheduling and the marking side.
//   • The unit of expiry is the attempt, not the order. `amend_order` /
//     `regenerate_pix` mint a SECOND PI against the same order and schedule
//     their own monitor pair, and the Payment model is attempt-scoped too
//     ("retry/regeneration creates a NEW Payment row"). An order-keyed marker
//     would let one attempt's payment silence another attempt's monitor.
//
// The defect this replaces: the scheduler passed the `pi_…` id under a field
// named `orderId`, while `markPixPaid` was called with the real order id — so
// the marker was written under a key the monitor never read, and a customer who
// had already paid still got "O PIX expirou".

import * as Sentry from "@sentry/node";
import { getRedisClient, rk, medusaAdmin } from "@ibatexas/tools";
import { createPaymentQueryService } from "@ibatexas/domain";
import { PaymentStatus } from "@ibatexas/types";
import type { Queue, Worker } from "bullmq";
import { mintCronReply } from "@adjudicate/core";
import { sendText } from "../whatsapp/client.js";
import logger from "../lib/logger.js";
import { assertDepsBag, createQueue, createWorker, type Job } from "./queue.js";

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
  /** BKL-241 — Stripe PaymentIntent id (`pi_…`) of the PIX attempt being watched. */
  paymentIntentId: string;
  stage: "reminder" | "expired";
}

/**
 * BKL-241 in-flight compat. Jobs enqueued by the PREVIOUS deploy carry the id
 * under `orderId` — which for every PIX producer ALREADY held the `pi_…` id
 * (the mislabelling was the defect), so reading it is a rename, not an id-space
 * change. A delayed job lives 25-30 min, so without this the jobs that survive
 * the deploy would key every lookup on `undefined`: `pix:paid:undefined` never
 * matches, and worse, the per-stage send claim collapses to ONE global key so
 * only the first of those customers is messaged at all.
 *
 * Drop once no pre-fix job can still be queued.
 */
type PersistedPixExpiryJobData = PixExpiryJobData & { readonly orderId?: string };

function readPaymentIntentId(data: PixExpiryJobData): string | undefined {
  const persisted = data as PersistedPixExpiryJobData;
  return persisted.paymentIntentId ?? persisted.orderId;
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  queue ??= createQueue("pix-expiry-monitor");
  return queue;
}

// ── The Redis client seam (R5 rollout, jobs/subscribers family) ──────────────
//
// PER-CONSUMER NARROWING (the R5-S1 rule): the three entry points reach
// different commands and are called from three different composition roots
// (`routes/stripe-webhook.ts` for `markPixPaid`, the BullMQ worker for
// `processPixExpiry`, and both for `isPixPaid`), so each takes its own type.
//
// FAIL-CLOSED PICK ANALYSIS (R5-S12's rule):
//   • `isPixPaid` ISSUES `get`. Its DB fallback goes through
//     `createPaymentQueryService()` (Prisma), which never sees this client.
//   • `markPixPaid` ISSUES `set`.
//   • `processPixExpiry` ISSUES `set` (the NX send claim) AND hands its client
//     DOWNSTREAM to `isPixPaid`, which issues `get`. Declaring only `set` here —
//     the "declare what the module issues" reading — compiles and typechecks and
//     is WRONG: the paid-check would throw and the customer who already paid
//     gets "O PIX expirou". So `PixExpiryProcessorRedis` is `get | set`, the
//     UNION, and its `get` is load-bearing for a command this function never
//     names.
//   • feature detection: none in this module's graph (measured).
//
// SWALLOWING: `isPixPaid`'s Redis `get` is OUTSIDE its try/catch (only the DB
// read is wrapped), so a client that cannot serve `get` throws rather than
// defaulting to unpaid. The NX claim in `processPixExpiry` is unwrapped too.

/** `isPixPaid` — the best-effort paid-flag read. */
export type PixPaidReadRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "get"
>;

/** `markPixPaid` — the paid-flag write. */
export type PixPaidWriteRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "set"
>;

/**
 * `processPixExpiry` — its own NX send claim (`set`) UNION the `get` its
 * `isPixPaid` call issues on the same client. See the fail-closed note above.
 */
export type PixExpiryProcessorRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "get" | "set"
>;

export interface IsPixPaidDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: PixPaidReadRedis;
}

export interface MarkPixPaidDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: PixPaidWriteRedis;
}

export interface ProcessPixExpiryDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: PixExpiryProcessorRedis;
}

/** Check if PIX payment was already confirmed (stripe webhook sets this key). */
export async function isPixPaid(
  paymentIntentId: string,
  deps: IsPixPaidDeps = {},
): Promise<boolean> {
  const redis: PixPaidReadRedis = deps.redis ?? (await getRedisClient());
  const paid = await redis.get(rk(`pix:paid:${paymentIntentId}`));
  if (paid) return true;

  // PIXPAIDFLAG: the Redis flag is best-effort — markPixPaid runs AFTER the DB write
  // and is catch-and-ignored on failure (stripe-webhook-processor handlePaymentSucceeded),
  // and the key carries a 2h TTL. If it is absent, confirm against the Payment projection
  // (the billing source of truth) so a customer who already paid never gets a spurious
  // "your PIX expired" message. Pure added read; no money movement.
  //
  // BKL-241: resolved by PI id — a findUnique on the unique `stripePaymentIntentId`
  // column, so it answers about THIS attempt. The previous getActiveByOrderId read
  // could not even be reached with the id the job actually carried, and is the
  // weaker question besides: with two attempts on one order it returns the
  // most-recent NON-TERMINAL row, which may be the pending retry rather than the
  // paid attempt being asked about.
  try {
    const payment = await createPaymentQueryService().getByStripePaymentIntentId(paymentIntentId);
    return payment?.status === PaymentStatus.PAID;
  } catch {
    // DB unavailable — preserve the unpaid default (a stray reminder is harmless).
    return false;
  }
}

/** BullMQ processor — sends reminder or expiry message if PIX is unpaid. */
export async function processPixExpiry(
  job: Job<PixExpiryJobData>,
  deps: ProcessPixExpiryDeps = {},
): Promise<void> {
  // Same fail-closed guard as `hesitation-nudge.ts` — see the note on
  // `assertDepsBag`: BullMQ calls a processor as `(job, token)`, and a lock-token
  // string in the deps slot degrades SILENTLY to the singleton default.
  assertDepsBag("pix-expiry-monitor", deps);
  const { phone, stage } = job.data;
  const paymentIntentId = readPaymentIntentId(job.data);

  // No id → the paid-check is unanswerable, so messaging would risk telling a
  // customer who already paid that their PIX expired. Fail closed (send nothing).
  if (!paymentIntentId) {
    logger.warn({ stage }, "[pix-expiry-monitor] job carries no payment intent id — skipping");
    return;
  }

  // Skip if already paid.
  //
  // The client threads THROUGH — `isPixPaid` runs on the same client this
  // processor was handed, which is why `PixExpiryProcessorRedis` carries a `get`
  // this function never issues itself.
  if (await isPixPaid(paymentIntentId, { redis: deps.redis })) return;

  // P3-NET-PIXREMINDER: per-stage idempotency around the message send. Jobs are
  // scheduled with removeOnComplete, so a retry re-runs this processor; without
  // a guard the customer gets a duplicate reminder/expiry WhatsApp. Claim the
  // send with SET NX (first runner wins); a null reply means another run already
  // sent this {paymentIntentId,stage}, so skip. This wraps ONLY the message send —
  // the isPixPaid() paid-check and all payment logic above are untouched.
  const redis: PixExpiryProcessorRedis = deps.redis ?? (await getRedisClient());
  const claimed = await redis.set(
    rk(`pix:reminder-sent:${paymentIntentId}:${stage}`),
    "1",
    { NX: true, EX: PIX_REMINDER_SENT_TTL_SECONDS },
  );
  if (!claimed) return;

  if (stage === "reminder") {
    await sendText(
      `whatsapp:${phone}`,
      mintCronReply("Seu QR PIX expira em 5 minutos! Ainda dá tempo de escanear 🍖"),
    );
  } else {
    // Check if this is a scheduled-pickup order — send a tailored message.
    //
    // BKL-241: the job carries a `pi_…` id, so it must be resolved to the Medusa
    // order id before the admin read — `/admin/orders/pi_…` only ever 404s. The
    // Payment projection is the PI→order map (regenerate_pix / the order.placed
    // subscriber both stamp `stripePaymentIntentId`). No row means no order exists
    // for this attempt yet (the common unpaid create_checkout case, where the cart
    // is completed only on payment) → generic message, same as before.
    let isScheduledPickup = false;
    try {
      const payment = await createPaymentQueryService().getByStripePaymentIntentId(paymentIntentId);
      if (payment?.orderId) {
        const orderData = (await medusaAdmin(`/admin/orders/${payment.orderId}`)) as {
          order?: { metadata?: Record<string, string> };
        };
        isScheduledPickup = orderData.order?.metadata?.["scheduledPickup"] === "true";
      }
    } catch {
      // If we can't resolve or fetch the order, fall through to the generic message
    }

    if (isScheduledPickup) {
      await sendText(
        `whatsapp:${phone}`,
        mintCronReply(
          "Seu PIX expirou, mas o pedido tá salvo! Manda 'novo pix' que gero outro, ou pode pagar em dinheiro/cartão na retirada.",
        ),
      );
    } else {
      await sendText(
        `whatsapp:${phone}`,
        mintCronReply("O PIX expirou, mas seu pedido tá salvo. Quer que eu gere um novo QR?"),
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

/**
 * Mark a PIX payment as confirmed (called from stripe webhook).
 *
 * BKL-241: MUST be the Stripe PaymentIntent id — the same id
 * {@link schedulePixExpiryMonitor} was given for this attempt. Passing the
 * Medusa order id here writes a key `isPixPaid` never reads.
 */
export async function markPixPaid(
  paymentIntentId: string,
  deps: MarkPixPaidDeps = {},
): Promise<void> {
  const redis: PixPaidWriteRedis = deps.redis ?? (await getRedisClient());
  // TTL 2h — plenty of time for any pending jobs to check
  await redis.set(rk(`pix:paid:${paymentIntentId}`), "1", { EX: 7200 });
}

export function startPixExpiryMonitor(): void {
  if (worker) return;
  // A one-argument WRAPPER, not `processPixExpiry` itself — BullMQ calls its
  // processor as `(job, token)` with a lock-token STRING, which would otherwise
  // land in the `deps` slot. See the identical note in `hesitation-nudge.ts`.
  worker = createWorker("pix-expiry-monitor", (job) =>
    processPixExpiry(job as Job<PixExpiryJobData>),
  );

  // The createWorker factory attaches a default "error" handler (connection-level
  // failures). Add a "failed" listener for PROCESSOR failures: jobs run with
  // removeOnFail, so a failed reminder/expiry send would otherwise vanish silently.
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
