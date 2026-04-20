// Follow-up poller
// Runs every 15 minutes via BullMQ repeatable job. Reads due follow-up entries
// from Redis sorted set and publishes follow-up.due NATS events.
// Idempotent across multiple instances.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** Core job logic — exported for direct testing. */
export async function processFollowUps(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger;
  const redis = await getRedisClient();
  const scheduledKey = rk("follow-up:scheduled");
  const now = Date.now();

  // Fetch all entries whose fire time has passed
  const due = await redis.zRangeByScore(scheduledKey, 0, now);

  effectiveLogger?.info({ batch_size: due.length, tick_at: new Date().toISOString() }, "follow-up poller tick");

  for (const member of due) {
    let parsed: { customerId: string; reason: string; scheduledAt: string };
    try {
      parsed = JSON.parse(member) as { customerId: string; reason: string; scheduledAt: string };
    } catch {
      // Malformed entry — remove it to avoid stuck processing
      await redis.zRem(scheduledKey, member);
      continue;
    }

    const { customerId, reason } = parsed;

    try {
      await publishNatsEvent("follow-up.due", { customerId, reason });
    } catch (err) {
      effectiveLogger?.error({ customerId, reason, error: String(err) }, "Failed to publish follow-up.due event");
      Sentry.withScope((scope) => {
        scope.setTag("job", "follow-up-poller");
        scope.setTag("source", "background-job");
        scope.setContext("follow_up", { customerId, reason });
        Sentry.captureException(err);
      });
      continue; // Leave in sorted set — will retry next tick
    }

    await redis.zRem(scheduledKey, member);
  }

  effectiveLogger?.info({ processed: due.length }, "[follow-up-poller] tick complete");
}

/** BullMQ processor. */
async function processor(_job: Job): Promise<void> {
  await processFollowUps();
}

export function startFollowUpPoller(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("follow-up-poller");
  worker = createWorker("follow-up-poller", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[follow-up-poller] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "follow-up-poller");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Add repeatable job + run immediately to drain any backlog from a restart
  void queue.upsertJobScheduler("follow-up-repeat", {
    every: REPEAT_INTERVAL_MS,
    immediately: true,
  });
}

export async function stopFollowUpPoller(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
