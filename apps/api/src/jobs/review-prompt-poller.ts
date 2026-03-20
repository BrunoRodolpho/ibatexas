// Review prompt poller
// Runs every 5 minutes via BullMQ repeatable job. Reads due review prompts
// from Redis sorted set and publishes review.prompt NATS events.
// Idempotent across multiple instances.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import * as Sentry from "@sentry/node";
import { createQueue, createWorker, type Job } from "./queue.js";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

const REPEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_CAP = 100; // max entries per tick (at 5000 orders/day ~= 17 per 5-min window)

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** Core job logic — exported for direct testing. */
export async function pollReviewPrompts(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger;
  const redis = await getRedisClient();
  const scheduledKey = rk("review:prompt:scheduled");
  const now = Date.now();

  // Fetch up to BATCH_CAP entries whose fire time has passed
  const due = await redis.zRangeByScore(scheduledKey, 0, now, { LIMIT: { offset: 0, count: BATCH_CAP } });

  effectiveLogger?.info({ batch_size: due.length, tick_at: new Date().toISOString() }, "review-prompt poller tick");

  if (due.length === BATCH_CAP) {
    effectiveLogger?.warn({ action: "review_prompt_batch_cap_reached", cap: BATCH_CAP }, "Poller hit batch cap — consider increasing frequency");
  }

  for (const member of due) {
    const [customerId, orderId] = member.split(":");
    if (!customerId || !orderId) continue;

    // Check if this specific key is still set (idempotency guard for duplicate cron runs)
    const marker = await redis.get(rk(`review:prompt:${customerId}:${orderId}`));
    if (!marker) {
      // Already processed or expired — clean up sorted set entry silently
      await redis.zRem(scheduledKey, member);
      continue;
    }

    try {
      await publishNatsEvent("review.prompt", {
        eventType: "review.prompt",
        customerId,
        orderId,
      });
    } catch (err) {
      effectiveLogger?.error({ customerId, orderId, error: String(err) }, "Failed to publish review.prompt event");
      Sentry.withScope((scope) => {
        scope.setTag("job", "review-prompt-poller");
        scope.setTag("source", "background-job");
        scope.setContext("review", { customerId, orderId });
        Sentry.captureException(err);
      });
      continue; // Leave in sorted set — will retry next tick
    }

    // Remove from sorted set + delete marker key
    const pipeline = redis.multi();
    pipeline.zRem(scheduledKey, member);
    pipeline.del(rk(`review:prompt:${customerId}:${orderId}`));
    await pipeline.exec();
  }
}

/** BullMQ processor. */
async function processor(_job: Job): Promise<void> {
  await pollReviewPrompts();
}

export function startReviewPromptPoller(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("review-prompt-poller");
  worker = createWorker("review-prompt-poller", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[review-prompt-poller] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "review-prompt-poller");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Add repeatable job + run immediately to drain any backlog from a restart
  void queue.upsertJobScheduler("review-prompt-repeat", {
    every: REPEAT_INTERVAL_MS,
    immediately: true,
  });
}

export async function stopReviewPromptPoller(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
