// Redis-backed session store for conversation history.
// Each session holds an ordered list of AgentMessage (user + assistant turns).
// TTL: 48h for guests (Step 11 auth will upgrade customers to 30d).
//
// Uses Redis list (RPUSH + LTRIM) for atomic append, avoiding read-modify-write races.

import { getRedisClient } from "@ibatexas/tools";
import type { AgentMessage } from "@ibatexas/types";

const SESSION_TTL_SECONDS = 48 * 60 * 60; // 48h
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
 */
export async function appendMessages(
  sessionId: string,
  messages: AgentMessage[],
): Promise<void> {
  const redis = await getRedisClient();
  const key = sessionKey(sessionId);

  const pipeline = redis.multi();
  for (const msg of messages) {
    pipeline.rPush(key, JSON.stringify(msg));
  }
  // Keep only the last MAX_HISTORY messages
  pipeline.lTrim(key, -MAX_HISTORY, -1);
  pipeline.expire(key, SESSION_TTL_SECONDS);
  await pipeline.exec();
}
