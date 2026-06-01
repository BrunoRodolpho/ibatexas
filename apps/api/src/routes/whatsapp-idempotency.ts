// WhatsApp webhook idempotency — two-phase claim primitives (P2-SEC-WAIDEMPOTENCY).
//
// Extracted from whatsapp-webhook.ts so BOTH the conductor path (handleInboundAsync)
// and the flag-OFF legacy path (whatsapp-legacy.ts handleInboundLegacy) promote/release
// the SAME dedup key — there is exactly one source of truth for `webhookKey`, so the
// claim and its confirm/release can never target different keys.
//
//   1. CLAIM   — SET NX with a SHORT in-flight TTL (route, before the 200). A Redis
//      error FAILS CLOSED (caller returns 503 → Twilio retries) rather than proceeding.
//   2. RUN     — the async turn.
//   3a. CONFIRM — on success, promote the key to the full 24h dedup window.
//   3b. RELEASE — on failure, DEL the claim so Twilio's retry reprocesses (the short
//       in-flight TTL is the backstop if the DEL itself fails).

import { getRedisClient, rk } from "@ibatexas/tools";

export const WA_DEDUP_TTL = 86400; // 24h — full dedup window (matches Twilio retry horizon)
export const WA_INFLIGHT_TTL = 300; // 5 min — claim lifetime before the turn confirms

export function webhookKey(messageSid: string): string {
  return rk(`wa:webhook:${messageSid}`);
}

export type IdempotencyClaim = "claimed" | "duplicate" | "unavailable";

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

/**
 * Phase 1 — claim the message for processing with a short in-flight TTL.
 *  • "claimed"     → first delivery, safe to process.
 *  • "duplicate"   → already claimed/processed, drop with 200.
 *  • "unavailable" → Redis error; FAIL CLOSED so Twilio retries.
 */
export async function claimIdempotency(
  redis: RedisClient,
  messageSid: string,
): Promise<IdempotencyClaim> {
  try {
    const wasSet = await redis.set(webhookKey(messageSid), "1", { EX: WA_INFLIGHT_TTL, NX: true });
    return wasSet ? "claimed" : "duplicate";
  } catch {
    return "unavailable";
  }
}

/** Phase 3a — promote the in-flight claim to the full dedup window on success. */
export async function confirmProcessed(
  redis: RedisClient,
  messageSid: string,
): Promise<void> {
  // SET without NX overwrites the short in-flight marker. Best-effort: if it
  // fails the in-flight TTL still suppresses duplicates until it expires.
  await redis.set(webhookKey(messageSid), "1", { EX: WA_DEDUP_TTL });
}

/** Phase 3b — release the claim so a Twilio retry can reprocess after failure. */
export async function releaseClaim(
  redis: RedisClient,
  messageSid: string,
): Promise<void> {
  await redis.del(webhookKey(messageSid));
}
