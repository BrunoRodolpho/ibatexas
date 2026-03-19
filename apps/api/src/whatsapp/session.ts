// WhatsApp session management.
//
// Maps WhatsApp phone numbers to sessionIds and customerIds via Redis.
// Auto-authenticates WhatsApp users by phone (phone IS identity on WhatsApp).
// Includes distributed agent lock with heartbeat + message debounce.

import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getRedisClient, rk } from "@ibatexas/tools";
import { createCustomerService } from "@ibatexas/domain";
import { Channel, type AgentContext } from "@ibatexas/types";

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h
const AGENT_LOCK_TTL_SECONDS = 30;
const AGENT_LOCK_HEARTBEAT_MS = 10_000;
const DEBOUNCE_TTL_SECONDS = 2;
// AUDIT-FIX: WA-M04 — Global rate limit on customer auto-creation to prevent DB write amplification
const MAX_CUSTOMER_CREATES_PER_MINUTE = 100;

// ── Phone utilities ────────────────────────────────────────────────────────────

/** Strip `whatsapp:` prefix and validate E.164 format. */
export function normalizePhone(from: string): string {
  const phone = from.replace(/^whatsapp:/, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error(`Invalid phone format: ${from}`);
  }
  return phone;
}

/** One-way hash of a phone number — safe to log. */
export function hashPhone(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 12);
}

// ── Session resolution ─────────────────────────────────────────────────────────

interface WhatsAppSession {
  phone: string;
  sessionId: string;
  customerId: string;
  isNew: boolean;
}

/**
 * Resolve a WhatsApp phone number to a session + customer.
 * Auto-authenticates: phone IS identity on WhatsApp (verified by Meta/Twilio).
 *
 * Flow:
 * 1. Check Redis cache for existing session
 * 2. If miss → upsert Customer in Prisma (auto-create on first contact)
 * 3. Create session in Redis with phone + customerId
 */
export async function resolveWhatsAppSession(phone: string): Promise<WhatsAppSession> {
  const hash = hashPhone(phone);
  const redis = await getRedisClient();
  const key = rk(`wa:phone:${hash}`);

  // Check Redis cache
  const cached = await redis.hGetAll(key);
  if (cached.sessionId && cached.customerId) {
    return {
      phone: cached.phone || phone,
      sessionId: cached.sessionId,
      customerId: cached.customerId,
      isNew: false,
    };
  }

  // AUDIT-FIX: WA-M04 — Rate limit customer creation to prevent DB write amplification
  // under broadcast reply storms (many unique phones). Uses INCR + unconditional EXPIRE
  // pattern (from REDIS-M03 fix) to avoid immortal keys.
  const rateLimitKey = rk("ratelimit:customer:create");
  const createCount = await redis.incr(rateLimitKey);
  await redis.expire(rateLimitKey, 60); // AUDIT-FIX: REDIS-M03 pattern — unconditional EXPIRE
  if (createCount > MAX_CUSTOMER_CREATES_PER_MINUTE) {
    throw new Error("Customer creation rate limit exceeded");
  }

  // Upsert customer — WhatsApp phone is pre-verified by Meta
  const customerSvc = createCustomerService();
  const customer = await customerSvc.upsertFromWhatsApp(phone);

  const sessionId = uuidv4();
  const now = new Date().toISOString();

  // Store in Redis
  await redis.hSet(key, {
    phone,
    sessionId,
    customerId: customer.id,
    lastMessageAt: now,
  });
  await redis.expire(key, SESSION_TTL_SECONDS);

  return {
    phone,
    sessionId,
    customerId: customer.id,
    isNew: true,
  };
}

/** Build AgentContext for WhatsApp channel. */
export function buildWhatsAppContext(session: WhatsAppSession): AgentContext {
  return {
    channel: Channel.WhatsApp,
    sessionId: session.sessionId,
    customerId: session.customerId,
    userType: "customer",
  };
}

/** Refresh session TTL on activity. */
export async function touchSession(hash: string): Promise<void> {
  const redis = await getRedisClient();
  const key = rk(`wa:phone:${hash}`);
  await redis.hSet(key, "lastMessageAt", new Date().toISOString());
  await redis.expire(key, SESSION_TTL_SECONDS);
}

// ── Agent lock (distributed, Redis-backed) ─────────────────────────────────────

const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Acquire a distributed agent lock for a phone.
 * Uses Redis SET NX with 30s TTL + heartbeat extension every 10s.
 * Returns true if lock was acquired.
 *
 * AUDIT-FIX: REDIS-H03/WA-H01 — lock keyed by phoneHash (not sessionId) to prevent
 * concurrent agent runs when session rotates mid-conversation.
 */
export async function acquireAgentLock(phoneHash: string): Promise<boolean> {
  const redis = await getRedisClient();
  const key = rk(`wa:agent:${phoneHash}`);

  const acquired = await redis.set(key, "1", { EX: AGENT_LOCK_TTL_SECONDS, NX: true });
  if (!acquired) return false;

  // Start heartbeat to extend TTL during long LLM calls
  const interval = setInterval(async () => {
    try {
      await redis.expire(key, AGENT_LOCK_TTL_SECONDS);
    } catch {
      // Redis may be down — lock will expire naturally
    }
  }, AGENT_LOCK_HEARTBEAT_MS);

  heartbeats.set(phoneHash, interval);
  return true;
}

/**
 * Release the agent lock. Clears heartbeat and deletes Redis key.
 *
 * AUDIT-FIX: REDIS-H03/WA-H01 — lock keyed by phoneHash (not sessionId).
 */
export async function releaseAgentLock(phoneHash: string): Promise<void> {
  const interval = heartbeats.get(phoneHash);
  if (interval) {
    clearInterval(interval);
    heartbeats.delete(phoneHash);
  }

  try {
    const redis = await getRedisClient();
    await redis.del(rk(`wa:agent:${phoneHash}`));
  } catch {
    // Best-effort cleanup — lock will expire via TTL
  }
}

// ── Message debounce ───────────────────────────────────────────────────────────

/**
 * Attempt to set the debounce key for a phone hash.
 * Returns true if this is the first message in the debounce window (caller should wait + run agent).
 * Returns false if debounce key already exists (message is queued, skip agent).
 */
export async function tryDebounce(hash: string): Promise<boolean> {
  const redis = await getRedisClient();
  const key = rk(`wa:debounce:${hash}`);
  const result = await redis.set(key, "1", { EX: DEBOUNCE_TTL_SECONDS, NX: true });
  return result === "OK";
}

// ── State management ───────────────────────────────────────────────────────────

/** Get the current conversation state from Redis session hash. */
export async function getSessionState(hash: string): Promise<string> {
  const redis = await getRedisClient();
  const key = rk(`wa:phone:${hash}`);
  const state = await redis.hGet(key, "state");
  return state || "idle";
}

/** Update the conversation state in Redis session hash. */
export async function setSessionState(hash: string, state: string): Promise<void> {
  const redis = await getRedisClient();
  const key = rk(`wa:phone:${hash}`);
  await redis.hSet(key, "state", state);
}
