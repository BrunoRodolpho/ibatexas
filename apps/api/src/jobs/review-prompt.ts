// Review prompt scheduler
// scheduleReviewPrompt() persists the review prompt in Redis for the cron poller.
// Does NOT use setTimeout — survives restarts and horizontal scaling.

import { getRedisClient } from "@ibatexas/tools";
import { rk } from "@ibatexas/tools";

const REVIEW_DELAY_MS = 30 * 60 * 1000; // 30 minutes after delivery

/**
 * Schedule a review prompt for customerId after an order is delivered.
 * Writes to:
 *   SET rk('review:prompt:{customerId}:{orderId}')  — used for idempotency check
 *   ZADD rk('review:prompt:scheduled')              — score = time to fire (nowMs + 30min)
 */
export async function scheduleReviewPrompt(
  customerId: string,
  orderId: string,
): Promise<void> {
  const redis = await getRedisClient();
  const member = `${customerId}:${orderId}`;
  const fireAt = Date.now() + REVIEW_DELAY_MS;

  const pipeline = redis.multi();
  // Mark as scheduled — 24h TTL (guard against re-scheduling the same order)
  pipeline.set(rk(`review:prompt:${customerId}:${orderId}`), orderId, { EX: 86400 });
  // Add to sorted set with timestamp-as-score for poller
  pipeline.zAdd(rk("review:prompt:scheduled"), { score: fireAt, value: member });
  await pipeline.exec();
}
