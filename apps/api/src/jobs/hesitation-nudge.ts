// Hesitation nudge — sends a reinforcement message to new customers
// who haven't replied within ~45s of receiving the first contact message.
//
// Flow:
// 1. whatsapp-webhook schedules a delayed BullMQ job (45s) after first_contact
// 2. When job fires, check if customer has replied (Redis key cleared)
// 3. If no reply → send nudge mentioning R$15 credit
// 4. If replied → skip (no-op)

import * as Sentry from "@sentry/node";
import { getRedisClient, rk } from "@ibatexas/tools";
import type { Queue, Worker } from "bullmq";
import { mintBroadcastReply } from "@adjudicate/core";
import { sendText } from "../whatsapp/client.js";
import logger from "../lib/logger.js";
import { shouldSuppressPromotionalSend } from "../broadcast/broadcast-optout.js";
import { assertDepsBag, createQueue, createWorker, type Job } from "./queue.js";

const NUDGE_DELAY_MS = Number.parseInt(
  process.env.HESITATION_NUDGE_DELAY_MS || "45000",
  10,
);

export interface NudgeJobData {
  phone: string;
  phoneHash: string;
  customerId: string;
}

export function buildHesitationNudgeMessage(): string {
  return "A propósito, no primeiro pedido você tem R$15 de crédito. Dá pra incluir um acompanhamento de graça praticamente — quer ver?";
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  queue ??= createQueue("hesitation-nudge");
  return queue;
}

// ── The Redis client seam (R5 rollout, jobs/subscribers family) ──────────────
//
// PER-CONSUMER NARROWING (the R5-S1 rule, as `session/store.ts` applies it): the
// two entry points reach DISJOINT commands, so they take disjoint client types.
// A client that can serve `markCustomerReplied` is not, by that fact, one that
// can serve the processor.
//
// FAIL-CLOSED PICK ANALYSIS (R5-S12's rule), per entry point:
//   • `processNudge` ISSUES `get` and `del`.
//   • `processNudge` hands the client to NOTHING. Its one downstream call that
//     could have taken it — `shouldSuppressPromotionalSend` — reaches Postgres
//     through `getBroadcastOptOutStore()` (a `BroadcastOptOutStore` over
//     Prisma), not Redis, so no command joins the Pick from that edge.
//   • `markCustomerReplied` ISSUES `set`, and hands the client to nothing.
//   • feature detection: none in either graph (measured).
//
// SWALLOWING: neither command is inside a catch here. `processNudge`'s failure
// surfaces to the BullMQ `failed` listener below (which logs + Sentry-reports),
// so a client missing a command is loud, not a silently-skipped nudge.

/** `processNudge` — the replied-marker read and its consuming delete. */
export type NudgeProcessorRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "get" | "del"
>;

/** `markCustomerReplied` — the marker write only. */
export type MarkRepliedRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "set"
>;

export interface ProcessNudgeDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: NudgeProcessorRedis;
}

export interface MarkCustomerRepliedDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: MarkRepliedRedis;
}

/**
 * BullMQ processor — checks if customer replied, sends nudge if not.
 *
 * Exported for the seam test. It is registered behind a ONE-ARGUMENT wrapper
 * (see `startHesitationNudgeWorker`) so BullMQ's lock token can never reach the
 * `deps` slot; `assertDepsBag` makes that requirement fail loudly instead of
 * silently.
 */
export async function processNudge(
  job: Job<NudgeJobData>,
  deps: ProcessNudgeDeps = {},
): Promise<void> {
  assertDepsBag("hesitation-nudge", deps);
  const { phone, phoneHash } = job.data;
  const redis: NudgeProcessorRedis = deps.redis ?? (await getRedisClient());

  // Check if customer replied (webhook handler sets this key on any reply)
  const repliedKey = rk(`wa:nudge:replied:${phoneHash}`);
  const replied = await redis.get(repliedKey);
  if (replied) {
    // Customer already replied — skip nudge
    await redis.del(repliedKey);
    return;
  }

  // WS3 / LGPD — the hesitation nudge is promotional; honor the opt-out.
  if (await shouldSuppressPromotionalSend(phone, logger)) {
    logger.info(
      { phone_hash: phoneHash },
      "[hesitation-nudge] suppressed (customer opted out of promotional messages)",
    );
    return;
  }

  await sendText(`whatsapp:${phone}`, mintBroadcastReply(buildHesitationNudgeMessage()));
}

/** Schedule a nudge for a new customer (called from whatsapp-webhook). */
export async function scheduleHesitationNudge(
  data: NudgeJobData,
): Promise<void> {
  const q = getQueue();
  await q.add("nudge", data, {
    delay: NUDGE_DELAY_MS,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/** Mark that customer replied (cancels pending nudge). */
export async function markCustomerReplied(
  phoneHash: string,
  deps: MarkCustomerRepliedDeps = {},
): Promise<void> {
  const redis: MarkRepliedRedis = deps.redis ?? (await getRedisClient());
  await redis.set(rk(`wa:nudge:replied:${phoneHash}`), "1", { EX: 120 });
}

export function startHesitationNudgeWorker(): void {
  if (worker) return;
  // A one-argument WRAPPER, not `processNudge` itself — BullMQ calls its
  // processor as `(job, token)` and the token would land in the `deps` slot.
  // See `assertDepsBag` in ./queue.ts for the full note; the guard makes a bare
  // registration throw rather than degrade silently.
  worker = createWorker("hesitation-nudge", (job) => processNudge(job as Job<NudgeJobData>));

  // The createWorker factory attaches a default "error" handler (connection-level
  // failures). Add a "failed" listener for PROCESSOR failures: jobs run with
  // removeOnFail, so a failed nudge send would otherwise vanish silently.
  worker.on("failed", (_job, err) => {
    logger.error({ err, job: "hesitation-nudge" }, "[hesitation-nudge] job failed");
    Sentry.withScope((scope) => {
      scope.setTag("job", "hesitation-nudge");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });
}

export async function stopHesitationNudgeWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
