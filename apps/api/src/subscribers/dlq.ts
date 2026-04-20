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

export async function pushToDlq(
  eventName: string,
  payload: Record<string, unknown>,
  error: unknown,
  log?: { error?: (...args: unknown[]) => void },
): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.lPush(
      rk(`dlq:${eventName}`),
      JSON.stringify({
        ...payload,
        _failedAt: new Date().toISOString(),
        _error: String(error),
      }),
    );
    await redis.expire(rk(`dlq:${eventName}`), DLQ_TTL);
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
