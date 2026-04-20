// Shared NATS idempotency guard for all subscribers.
//
// Prevents duplicate processing on redelivery by setting a Redis key with
// SET NX + TTL. Returns true if this event has NOT been processed yet.

import { getRedisClient, rk } from "@ibatexas/tools";

const NATS_DEDUP_TTL = 604_800; // 7 days — matches Stripe webhook window

/**
 * NATS idempotency guard — prevents duplicate processing on redelivery.
 * Returns true if this event has NOT been processed yet (safe to proceed).
 * Returns false if already processed (skip handler).
 */
export async function isNewEvent(eventKey: string): Promise<boolean> {
  const redis = await getRedisClient();
  const result = await redis.set(rk(`nats:processed:${eventKey}`), "1", { EX: NATS_DEDUP_TTL, NX: true });
  return result === "OK";
}
