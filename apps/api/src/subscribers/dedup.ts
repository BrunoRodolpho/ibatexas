// Shared NATS idempotency guard for all subscribers.
//
// Prevents duplicate processing on redelivery by setting a Redis key with
// SET NX + TTL.
//
// Two APIs:
//   • `withDedup(key, handler)` — two-phase guard (PREFERRED for side-effecting
//     handlers): claims a short-lived in-flight marker, runs the handler, and
//     only on success promotes the marker to the full dedup TTL. If the handler
//     throws, the claim is released so NATS redelivery reprocesses the event
//     (at-least-once). A Redis error while claiming fails CLOSED — the handler
//     is skipped and redelivery retries — rather than proceeding unguarded.
//   • `isNewEvent(key)` — single-phase claim (at-most-once). Returns true if
//     this event has NOT been processed yet (safe to proceed), false if already
//     processed. Suitable for guards where dropping a rare duplicate side-effect
//     on a handler crash is acceptable (e.g. staff alerts). Throws on Redis
//     error; callers decide fail-open vs fail-closed in their own catch.

import { getRedisClient, rk } from "@ibatexas/tools";

const NATS_DEDUP_TTL = 604_800; // 7 days — matches Stripe webhook window
const NATS_INFLIGHT_TTL = 300; // 5 min — claim lifetime before handler confirms

function processedKey(eventKey: string): string {
  return rk(`nats:processed:${eventKey}`);
}

/**
 * NATS idempotency guard — single-phase claim (at-most-once).
 * Marks the event processed immediately (full TTL) and returns true if this
 * event had NOT been claimed yet (safe to proceed), false if already processed.
 *
 * Throws if Redis is unreachable — the caller decides how to react (fail-open
 * vs fail-closed) in its own try/catch.
 */
export async function isNewEvent(eventKey: string): Promise<boolean> {
  const redis = await getRedisClient();
  const result = await redis.set(processedKey(eventKey), "1", { EX: NATS_DEDUP_TTL, NX: true });
  return result === "OK";
}

/**
 * Promote an in-flight claim to the full dedup TTL, confirming the event as
 * fully processed. Idempotent: uses SET (no NX) so it overwrites the short
 * in-flight marker left by the claim phase.
 */
export async function markProcessed(eventKey: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(processedKey(eventKey), "1", { EX: NATS_DEDUP_TTL });
}

/**
 * Release a claim so a redelivery can reprocess the event. Best-effort —
 * if it fails, the short in-flight TTL still lets the claim expire naturally.
 */
async function releaseClaim(eventKey: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(processedKey(eventKey));
  } catch {
    // Best-effort — the in-flight TTL guarantees the claim eventually expires.
  }
}

/**
 * Two-phase idempotency guard for side-effecting handlers.
 *
 * 1. Claim: SET NX with a short in-flight TTL. If already claimed → duplicate,
 *    skip silently (returns false).
 * 2. Run the handler.
 * 3. Confirm: on success, promote the claim to the full dedup TTL (returns true).
 *    On handler throw, release the claim so redelivery reprocesses, then rethrow.
 *
 * Fail-closed: if the claim itself errors (Redis unreachable), the handler is
 * NOT run and `false` is returned, leaving the event unacknowledged so NATS
 * redelivers it. This avoids the at-most-once hazard of marking-before-running.
 *
 * @returns true if the handler ran to completion (newly processed),
 *          false if skipped (duplicate, or claim failed → redelivery will retry).
 */
export async function withDedup(
  eventKey: string,
  handler: () => Promise<void>,
): Promise<boolean> {
  // ── Phase 1: claim (fail CLOSED on Redis error) ──────────────────────────
  let claimed: boolean;
  try {
    const redis = await getRedisClient();
    const result = await redis.set(processedKey(eventKey), "1", {
      EX: NATS_INFLIGHT_TTL,
      NX: true,
    });
    claimed = result === "OK";
  } catch (err) {
    // Dedup check failed — skip processing and let NATS redeliver rather than
    // proceeding unguarded (which risks duplicate side-effects on every replica).
    throw new DedupUnavailableError(eventKey, err);
  }

  if (!claimed) return false; // already processed / in flight → duplicate

  // ── Phase 2: run handler, then confirm ───────────────────────────────────
  try {
    await handler();
  } catch (err) {
    // Handler failed — release the claim so redelivery reprocesses (at-least-once).
    await releaseClaim(eventKey);
    throw err;
  }

  // ── Phase 3: confirm (promote to full TTL) ───────────────────────────────
  // Best-effort: if the promote fails, the in-flight claim still suppresses
  // duplicates until its short TTL expires.
  try {
    await markProcessed(eventKey);
  } catch {
    // Non-fatal — handler already succeeded; worst case is a re-process after
    // the short in-flight TTL, which the handler's own idempotency absorbs.
  }
  return true;
}

/**
 * Raised by `withDedup` when the dedup claim cannot be performed (Redis down).
 * Signals a fail-closed skip — the event should be left unacknowledged so NATS
 * redelivers it.
 */
export class DedupUnavailableError extends Error {
  constructor(eventKey: string, cause: unknown) {
    super(`Dedup check unavailable for "${eventKey}": ${String(cause)}`);
    this.name = "DedupUnavailableError";
  }
}
