// AUDIT-FIX: EVT-F01 — Outbox retry job
// Polls Redis outbox lists every 60s and re-publishes undelivered critical events.
// Critical events: order.placed, reservation.created
//
// Idempotency is guaranteed by the subscriber-side dedup guard (isNewEvent).

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent, outboxKey } from "@ibatexas/nats-client";
import type { FastifyBaseLogger } from "fastify";

const OUTBOX_INTERVAL_MS = 60_000; // 60 seconds
const CRITICAL_EVENTS = ["order.placed", "reservation.created"] as const;

let timer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

async function processOutbox(log?: FastifyBaseLogger): Promise<void> {
  // AUDIT-FIX: EVT-F01 — Overlap guard (prevents concurrent runs)
  if (isRunning) return;
  isRunning = true;

  try {
    const redis = await getRedisClient();
    const envPrefix = process.env.APP_ENV ?? "development";

    for (const event of CRITICAL_EVENTS) {
      const key = outboxKey(envPrefix, event);
      // Read all pending outbox entries (LRANGE 0 -1)
      const entries = await redis.lRange(key, 0, -1);

      if (entries.length === 0) continue;

      log?.info(
        { event, count: entries.length },
        "[outbox-retry] Re-publishing undelivered events",
      );

      for (const entry of entries) {
        try {
          const payload = JSON.parse(entry) as Record<string, unknown>;
          // Re-publish via NATS (this will also attempt to LREM from outbox on success)
          await publishNatsEvent(event, payload);
        } catch (err) {
          log?.error(
            { event, error: String(err) },
            "[outbox-retry] Failed to re-publish event",
          );
        }
      }
    }
  } catch (err) {
    log?.error({ error: String(err) }, "[outbox-retry] Outbox poll error");
  } finally {
    isRunning = false;
  }
}

export function startOutboxRetry(log?: FastifyBaseLogger): void {
  // Run once immediately, then every OUTBOX_INTERVAL_MS
  void processOutbox(log).catch((err) =>
    log?.error({ error: String(err) }, "[outbox-retry] Initial run failed"),
  );
  timer = setInterval(() => {
    void processOutbox(log).catch((err) =>
      log?.error({ error: String(err) }, "[outbox-retry] Interval run failed"),
    );
  }, OUTBOX_INTERVAL_MS);
}

export function stopOutboxRetry(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
