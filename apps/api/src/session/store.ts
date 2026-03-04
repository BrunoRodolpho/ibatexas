// Redis-backed session store for conversation history.
// Each session holds an ordered list of AgentMessage (user + assistant turns).
// TTL: 24h for authenticated customers, 48h for guests (Step 11 auth upgrade).
//
// Uses Redis list (RPUSH + LTRIM) for atomic append, avoiding read-modify-write races.

import { getRedisClient } from "@ibatexas/tools";
import type { AgentMessage } from "@ibatexas/types";

const GUEST_SESSION_TTL_SECONDS = 48 * 60 * 60; // 48h
const CUSTOMER_SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h
const MAX_HISTORY = 50;

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * Load conversation history for a session.
 * Returns an empty array if the session does not exist.
 */
export async function loadSession(sessionId: string): Promise<AgentMessage[]> {
  const redis = await getRedisClient();
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
): Promise<void> {
  const redis = await getRedisClient();
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
}
