// Review prompt poller
// Runs every 5 minutes. Reads due review prompts from Redis sorted set and
// publishes review.prompt NATS events. Idempotent across multiple instances.
//
// Uses same registration pattern as no-show-checker.ts.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import type { FastifyBaseLogger } from "fastify";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_CAP = 100; // max entries per tick (at 5000 orders/day ≈ 17 per 5-min window)

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let logger: FastifyBaseLogger | null = null;

async function pollReviewPrompts(): Promise<void> {
  const redis = await getRedisClient();
  const scheduledKey = rk("review:prompt:scheduled");
  const now = Date.now();

  // Fetch up to BATCH_CAP entries whose fire time has passed
  const due = await redis.zRangeByScore(scheduledKey, 0, now, { LIMIT: { offset: 0, count: BATCH_CAP } });

  logger?.info({ batch_size: due.length, tick_at: new Date().toISOString() }, "review-prompt poller tick");

  if (due.length === BATCH_CAP) {
    logger?.warn({ action: "review_prompt_batch_cap_reached", cap: BATCH_CAP }, "Poller hit batch cap — consider increasing frequency");
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
      logger?.error({ customerId, orderId, error: String(err) }, "Failed to publish review.prompt event");
      continue; // Leave in sorted set — will retry next tick
    }

    // Remove from sorted set + delete marker key
    const pipeline = redis.multi();
    pipeline.zRem(scheduledKey, member);
    pipeline.del(rk(`review:prompt:${customerId}:${orderId}`));
    await pipeline.exec();
  }
}

export function startReviewPromptPoller(log?: FastifyBaseLogger): void {
  if (intervalHandle) return;
  logger = log ?? null;
  intervalHandle = setInterval(() => {
    void pollReviewPrompts().catch((err) => {
      logger?.error(err, "[review-prompt-poller] Unexpected error");
    });
  }, CHECK_INTERVAL_MS);
  // Run immediately on start to drain any backlog from a restart
  void pollReviewPrompts().catch(() => {});
}

export function stopReviewPromptPoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
