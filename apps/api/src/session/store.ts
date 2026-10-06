// Redis-backed session store for conversation history.
// Each session holds an ordered list of AgentMessage (user + assistant turns).
// TTL: 24h for authenticated customers, 48h for guests (Step 11 auth upgrade).
//
// Uses Redis list (RPUSH + LTRIM) for atomic append, avoiding read-modify-write races.

import { getRedisClient, rk } from "@ibatexas/tools";
import type { AgentMessage } from "@ibatexas/types";

const GUEST_SESSION_TTL_SECONDS = 48 * 60 * 60; // 48h
const CUSTOMER_SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h
const MAX_HISTORY = 50;

// ── The Redis client seam (R5 rollout) ─────────────────────────────────────
//
// This module is `redis-double-census.md`'s class (c) — route-reachable, but
// NOT through `CartRouteDeps`: its four callers (`routes/chat.ts`,
// `routes/whatsapp-webhook.ts`, `subscribers/cart-intelligence.ts`,
// `jobs/abandoned-cart-checker.ts`) are four different composition roots, and
// threading it through any one of them would be a lie to the other three. So it
// takes the R5-S6 injectable-client shape (`catalog/estimate-delivery.ts`'s
// `DeliveryCacheClient`) instead: an options bag per entry point, defaulting to
// the singleton resolved at the same point it always was.
//
// PER-CONSUMER NARROWING (the R5-S1 rule): the two entry points reach DISJOINT
// commands, so they take disjoint client types. A client that can serve
// `loadSession` is not, by that fact, one that can serve `appendMessages`.
//
// Fail-closed analysis: both commands are ISSUED unconditionally, neither is
// feature-detected, and neither call is inside a swallowing catch — the
// `try/catch` in `loadSession` wraps `JSON.parse` only, and the one in
// `appendMessages` wraps the NATS publish only. A client missing its command
// therefore throws to the caller instead of degrading to an empty history.

/** `loadSession` — the whole history read, HEAD to TAIL. */
export type SessionHistoryReadClient = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "lRange"
>;

/**
 * `appendMessages` — the RPUSH/LTRIM/EXPIRE pipeline.
 *
 * `multi` only: the three commands are queued on the PIPELINE, never on the
 * client, so declaring them here would misname which object receives them.
 * node-redis types the pipeline off `multi`'s return type, so `tsc` still
 * checks every queued command exactly.
 */
export type SessionHistoryAppendClient = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "multi"
>;

/** Injection point shared by both entry points, parameterized by client type. */
export interface SessionStoreOptions<TClient> {
  /**
   * Redis-shaped client this call runs on. Defaults to the process singleton,
   * resolved at the SAME point in the same function it always was — so every
   * production call site stays a bare `loadSession(id)` /
   * `appendMessages(id, msgs, …)`.
   */
  readonly client?: TClient;
}

function sessionKey(sessionId: string): string {
  return rk(`session:${sessionId}`);
}

/**
 * Load conversation history for a session.
 * Returns an empty array if the session does not exist.
 */
export async function loadSession(
  sessionId: string,
  options?: SessionStoreOptions<SessionHistoryReadClient>,
): Promise<AgentMessage[]> {
  const redis: SessionHistoryReadClient = options?.client ?? (await getRedisClient());
  const key = sessionKey(sessionId);
  const items = await redis.lRange(key, 0, -1);
  if (!items || items.length === 0) return [];
  try {
    return items.map((raw) => JSON.parse(raw) as AgentMessage);
  } catch {
    return [];
  }
}

/**
 * Append new messages to the session history.
 * Uses RPUSH + LTRIM atomically via pipeline to avoid race conditions.
 * Resets the TTL on each append.
 * Pass isAuthenticated=true to upgrade TTL to customer window.
 */
export async function appendMessages(
  sessionId: string,
  messages: AgentMessage[],
  isAuthenticated = false,
  meta?: { customerId?: string; channel?: "whatsapp" | "web" },
  options?: SessionStoreOptions<SessionHistoryAppendClient>,
): Promise<void> {
  const redis: SessionHistoryAppendClient = options?.client ?? (await getRedisClient());
  const key = sessionKey(sessionId);
  const ttl = isAuthenticated ? CUSTOMER_SESSION_TTL_SECONDS : GUEST_SESSION_TTL_SECONDS;

  const pipeline = redis.multi();
  for (const msg of messages) {
    pipeline.rPush(key, JSON.stringify(msg));
  }
  // Keep only the last MAX_HISTORY messages
  pipeline.lTrim(key, -MAX_HISTORY, -1);
  pipeline.expire(key, ttl);
  await pipeline.exec();

  // CDC: publish NATS event for durable Postgres archival (best-effort)
  try {
    const natsModule = await import("@ibatexas/nats-client")
    void natsModule.publishNatsEvent("conversation.message.appended", {
      sessionId,
      customerId: meta?.customerId ?? null,
      channel: meta?.channel ?? (isAuthenticated ? "whatsapp" : "web"),
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        sentAt: new Date().toISOString(),
      })),
    })
  } catch {
    // Non-critical — Redis is the hot path, Postgres archival is best-effort
  }
}
