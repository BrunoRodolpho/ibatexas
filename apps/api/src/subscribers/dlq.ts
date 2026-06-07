// Dead Letter Queue utility — pushes failed events to a Redis list for ops inspection.
//
// Usage:
//   import { pushToDlq } from "./dlq.js";
//   await pushToDlq("order.placed", payload, error, log);
//
// Each DLQ key follows the pattern: {env}:dlq:{eventName}
// Entries expire after 7 days (matches outbox / dedup TTL).

import { getRedisClient, rk } from "@ibatexas/tools";
import * as Sentry from "@sentry/node";

const DLQ_TTL = 604_800; // 7 days

// Cap each DLQ list so it cannot grow unbounded within its 7-day TTL.
// lPush puts newest entries at the head, so lTrim(0, MAX_DLQ-1) keeps the most
// recent MAX_DLQ entries and discards the oldest from the tail.
const MAX_DLQ = process.env.MAX_DLQ ? Number(process.env.MAX_DLQ) : 1000;

export async function pushToDlq(
  eventName: string,
  payload: Record<string, unknown>,
  error: unknown,
  log?: { error?: (...args: unknown[]) => void },
): Promise<void> {
  try {
    const redis = await getRedisClient();
    const key = rk(`dlq:${eventName}`);
    const newLen = await redis.lPush(
      key,
      JSON.stringify({
        ...payload,
        _failedAt: new Date().toISOString(),
        _error: String(error),
      }),
    );
    // Cap the list to MAX_DLQ; drop oldest entries past the cap so it cannot grow
    // unbounded within the 7-day TTL.
    if (newLen > MAX_DLQ) {
      await redis.lTrim(key, 0, MAX_DLQ - 1);
      const dropped = newLen - MAX_DLQ;
      log?.error?.(
        { event: eventName, dropped, cap: MAX_DLQ },
        "[dlq] DLQ list exceeded cap — dropped oldest entries",
      );
    }
    await redis.expire(key, DLQ_TTL);
  } catch (dlqErr) {
    log?.error?.(
      { event: eventName, error: String(dlqErr) },
      "[dlq] Failed to push to DLQ",
    );
  }

  // Alert via Sentry so ops is notified without manual Redis inspection
  Sentry.withScope((scope) => {
    scope.setTag("dlq_event", eventName);
    scope.setLevel("warning");
    Sentry.captureMessage(`DLQ entry added: ${eventName}`);
  });
}
