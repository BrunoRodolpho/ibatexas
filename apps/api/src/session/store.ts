// Redis-backed session store for conversation history.
// Each session holds an ordered list of AgentMessage (user + assistant turns).
// TTL: 48h for guests (Step 11 auth will upgrade customers to 30d).

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
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as AgentMessage[];
  } catch {
    return [];
  }
}

/**
 * Append new messages to the session history.
 * Trims to the last MAX_HISTORY messages and resets the TTL.
 */
export async function appendMessages(
  sessionId: string,
  messages: AgentMessage[],
): Promise<void> {
  const redis = await getRedisClient();
  const existing = await loadSession(sessionId);
  const updated = [...existing, ...messages].slice(-MAX_HISTORY);
  await redis.set(sessionKey(sessionId), JSON.stringify(updated), {
    EX: SESSION_TTL_SECONDS,
  });
}
