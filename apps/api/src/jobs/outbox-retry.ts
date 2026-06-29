// Outbox retry job — polls Redis outbox lists every 60s via BullMQ repeatable
// job and re-publishes undelivered critical events.
// Critical events: order.placed, reservation.created
//
// Idempotency is guaranteed by the subscriber-side dedup guard (isNewEvent).

import crypto from "node:crypto";
import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent, outboxKey, OUTBOX_EVENTS } from "@ibatexas/nats-client";
import { pushToDlq } from "../subscribers/dlq.js";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 60_000; // 60 seconds

// Bounded page size per cycle. Reading the whole list (LRANGE 0 -1) loaded an
// unbounded backlog into memory each run (P1-SCALE-OUTBOXMEM); we now read at
// most this many head entries per event per cycle. The list is bounded on the
// write side too (OUTBOX_MAX_LEN in @ibatexas/nats-client).
const OUTBOX_PAGE_SIZE = Number.parseInt(process.env.OUTBOX_PAGE_SIZE || "500", 10);
// Events the retry job re-publishes. Single source of truth: the retry set IS the
// set actually persisted to the outbox (OUTBOX_EVENTS in @ibatexas/nats-client), so
// an event can never be "retried but never persisted" (the P0-PAY-4 regression) nor
// "persisted but never retried" (customer.anonymize.medusa.pending). The drift-guard
// test pins the two sets equal.
export const CRITICAL_EVENTS: readonly string[] = [...OUTBOX_EVENTS];

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/**
 * Process a single outbox entry: parse it, re-publish via NATS, and route a
 * poison (unparseable) entry to the DLQ. Extracted from {@link processOutbox} to
 * keep that function's nesting/complexity bounded; behavior is identical to the
 * inlined per-entry loop body (a parse failure short-circuits via `return`,
 * which is equivalent to the loop's previous `continue`).
 */
async function processOutboxEntry(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  event: string,
  key: string,
  entry: string,
  effectiveLogger: FastifyBaseLogger | null,
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(entry) as Record<string, unknown>;
  } catch (parseErr) {
    // Poison entry — unparseable, can never be re-published. Move it to
    // the DLQ and remove it from the outbox so it stops blocking the page.
    effectiveLogger?.error(
      { event, error: String(parseErr) },
      "[outbox-retry] Poison outbox entry — routing to DLQ",
    );
    await pushToDlq(event, { _rawEntry: entry }, parseErr, effectiveLogger ?? undefined);
    try {
      await redis.lRem(key, 1, entry);
    } catch (remErr) {
      effectiveLogger?.error(
        { event, error: String(remErr) },
        "[outbox-retry] Failed to remove poison entry from outbox",
      );
    }
    return;
  }

  try {
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
    // Parseable but publish failed: leave it in the outbox (publishNatsEvent
    // only LREMs on success) so the next cycle retries it. No per-entry
    // attempt cap — subscriber dedup (isNewEvent) keys on payload content and
    // the outbox uses exact-string LREM, so embedding a counter would mutate
    // the stored entry and break both. Unbounded growth is capped on the
    // write side (OUTBOX_MAX_LEN lTrim) + bounded read here; a durable
    // attempt cap is deferred to the JetStream migration (max-deliver + DLQ).
  }
}

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
      // Read a bounded page of pending outbox entries (LRANGE 0 N-1) instead of
      // the whole list, so a large backlog can't blow up memory in one cycle.
      // Remaining entries are picked up on subsequent cycles.
      const entries = await redis.lRange(key, 0, OUTBOX_PAGE_SIZE - 1);

      if (entries.length === 0) continue;

      effectiveLogger?.info(
        { event, count: entries.length, pageSize: OUTBOX_PAGE_SIZE },
        "[outbox-retry] Re-publishing undelivered events (bounded page)",
      );

      for (const entry of entries) {
        await processOutboxEntry(redis, event, key, entry, effectiveLogger);
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
  const jitter = crypto.randomInt(15_000);
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
