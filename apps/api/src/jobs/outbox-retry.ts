// Outbox retry job — polls Redis outbox lists every 60s via BullMQ repeatable
// job and re-publishes undelivered critical events.
// Critical events: order.placed, reservation.created
//
// Idempotency is guaranteed by the subscriber-side dedup guard (isNewEvent).

import crypto from "node:crypto";
import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent, outboxKey } from "@ibatexas/nats-client";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 60_000; // 60 seconds
const CRITICAL_EVENTS = [
  "order.placed",
  "reservation.created",
  "order.status_changed",
  "order.refunded",
  "order.disputed",
  "order.canceled",
  "order.payment_failed",
  "payment.status_changed",
] as const;

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** Core job logic — exported for direct testing. */
export async function processOutbox(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger;

  const redis = await getRedisClient();

  // Distributed lock: prevent concurrent retry runs from re-publishing duplicates.
  // TTL is 55s — shorter than the 60s repeat interval so the lock never outlasts a cycle.
  const lockKey = rk("lock:outbox-retry");
  const lockValue = crypto.randomUUID();
  const acquired = await redis.set(lockKey, lockValue, { EX: 55, NX: true });
  if (!acquired) {
    effectiveLogger?.info("[outbox-retry] Another instance is already processing — skipping");
    return;
  }

  try {
    const envPrefix = process.env.APP_ENV ?? "development";

    for (const event of CRITICAL_EVENTS) {
      const key = outboxKey(envPrefix, event);
      // Read all pending outbox entries (LRANGE 0 -1)
      const entries = await redis.lRange(key, 0, -1);

      if (entries.length === 0) continue;

      effectiveLogger?.info(
        { event, count: entries.length },
        "[outbox-retry] Re-publishing undelivered events",
      );

      for (const entry of entries) {
        try {
          const payload = JSON.parse(entry) as Record<string, unknown>;
          // Re-publish via NATS (this will also attempt to LREM from outbox on success)
          await publishNatsEvent(event, payload);
        } catch (err) {
          effectiveLogger?.error(
            { event, error: String(err) },
            "[outbox-retry] Failed to re-publish event",
          );
          Sentry.withScope((scope) => {
            scope.setTag("job", "outbox-retry");
            scope.setTag("source", "background-job");
            scope.setContext("event", { eventType: event });
            Sentry.captureException(err);
          });
        }
      }
    }
  } finally {
    // Conditional Lua release: only delete the key if we still own it.
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      { keys: [lockKey], arguments: [lockValue] },
    );
  }
}

/** BullMQ processor. */
async function processor(_job: Job): Promise<void> {
  await processOutbox();
}

export function startOutboxRetry(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("outbox-retry");
  worker = createWorker("outbox-retry", processor);

  worker.on("failed", (_job, err) => {
    logger?.error({ error: String(err) }, "[outbox-retry] Interval run failed");
    Sentry.withScope((scope) => {
      scope.setTag("job", "outbox-retry");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Run immediately on startup, then every REPEAT_INTERVAL_MS + jitter.
  // Jitter (0-15s) prevents thundering herd when multiple instances restart.
  const jitter = Math.floor(Math.random() * 15_000);
  void queue.upsertJobScheduler("outbox-retry-repeat", {
    every: REPEAT_INTERVAL_MS + jitter,
    immediately: true,
  });
}

export async function stopOutboxRetry(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
