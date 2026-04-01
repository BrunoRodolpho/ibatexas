// WhatsApp session management.
//
// Maps WhatsApp phone numbers to sessionIds and customerIds via Redis.
// Auto-authenticates WhatsApp users by phone (phone IS identity on WhatsApp).
// Includes distributed agent lock with heartbeat + message debounce.

import { createHash, randomUUID } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getRedisClient, rk, atomicIncr } from "@ibatexas/tools";
import { createCustomerService } from "@ibatexas/domain";
import { Channel, type AgentContext } from "@ibatexas/types";

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h
const SESSION_IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes — triggers session rotation
const AGENT_LOCK_TTL_SECONDS = 30;
const AGENT_LOCK_HEARTBEAT_MS = 10_000;
const DEBOUNCE_TTL_SECONDS = 2;
// Global rate limit on customer auto-creation to prevent DB write amplification
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

/**
 * One-way hash of a phone number — safe to log.
 *
 * Truncation to 12 hex chars provides 48-bit collision space (~50% collision at
 * ~16.8M phones). A collision would share rate limit/debounce windows (keyed by
 * hash), but NOT session data (uses actual phone for Prisma lookup).
 * If scaling to millions of phones, increase to 16+ hex chars.
 */
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
 * Lua script: atomic check-and-rotate session.
 * Prevents TOCTOU race where two concurrent messages after idle both
 * create new sessions. The script atomically checks lastMessageAt,
 * rotates if idle > threshold, and updates the timestamp.
 *
 * Returns the (possibly rotated) sessionId.
 */
const ROTATE_SESSION_SCRIPT = `
local lastMsg = redis.call('HGET', KEYS[1], 'lastMessageAt')
local threshold = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local newSessionId = ARGV[3]

if lastMsg and (now - tonumber(lastMsg)) > threshold then
  redis.call('HSET', KEYS[1], 'sessionId', newSessionId, 'lastMessageAt', tostring(now))
  return newSessionId
else
  redis.call('HSET', KEYS[1], 'lastMessageAt', tostring(now))
  return redis.call('HGET', KEYS[1], 'sessionId')
end
`;

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
    // ── Ephemeral session scoping: rotate sessionId after 30min idle ──────
    // This prevents stale cart data, machine snapshots, and conversation
    // history from a previous interaction bleeding into a new conversation.
    // The old machine snapshot (wa:machine:{oldSessionId}) dies naturally
    // via TTL; the old Medusa cart is orphaned and expires independently.
    //
    // Uses atomic Lua script to prevent TOCTOU race: two concurrent
    // messages after idle could both see stale lastMessageAt and both
    // rotate, creating duplicate sessions. The Lua script does the
    // check-and-rotate atomically in Redis.
    const candidateSessionId = uuidv4();
    const nowMs = Date.now();

    const resolvedSessionId = await redis.eval(ROTATE_SESSION_SCRIPT, {
      keys: [key],
      arguments: [
        String(SESSION_IDLE_THRESHOLD_MS),
        String(nowMs),
        candidateSessionId,
      ],
    }) as string;

    await redis.expire(key, SESSION_TTL_SECONDS);

    return {
      phone: cached.phone || phone,
      sessionId: resolvedSessionId,
      customerId: cached.customerId,
      isNew: false,
    };
  }

  // Rate limit customer creation to prevent DB write amplification under broadcast
  // reply storms. SEC-003: atomic INCR + EXPIRE via Lua to prevent immortal keys.
  const rateLimitKey = rk("ratelimit:customer:create");
  const createCount = await atomicIncr(redis, rateLimitKey, 60);
  if (createCount > MAX_CUSTOMER_CREATES_PER_MINUTE) {
    throw new Error("Customer creation rate limit exceeded");
  }

  // Upsert customer — WhatsApp phone is pre-verified by Meta
  const customerSvc = createCustomerService();
  const customer = await customerSvc.upsertFromWhatsApp(phone);

  const sessionId = uuidv4();
  const nowMs = String(Date.now());

  // Store in Redis
  await redis.hSet(key, {
    phone,
    sessionId,
    customerId: customer.id,
    lastMessageAt: nowMs,
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
export function buildWhatsAppContext(
  session: WhatsAppSession,
  lastLocation?: { lat: number; lng: number } | null,
  hints?: string[],
): AgentContext {
  return {
    channel: Channel.WhatsApp,
    sessionId: session.sessionId,
    customerId: session.customerId,
    userType: "customer",
    ...(lastLocation ? { lastLocation } : {}),
    ...(hints?.length ? { hints } : {}),
  };
}

/** Refresh session TTL on activity. */
export async function touchSession(hash: string): Promise<void> {
  const redis = await getRedisClient();
  const key = rk(`wa:phone:${hash}`);
  await redis.hSet(key, "lastMessageAt", String(Date.now()));
  await redis.expire(key, SESSION_TTL_SECONDS);
}

// ── Agent lock (distributed, Redis-backed, ownership-safe) ──────────────────

const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Lua script: conditional DEL — only deletes if the lock value matches.
 * Prevents releasing a lock that was acquired by a different process after
 * our TTL expired.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

/**
 * Lua script: conditional EXPIRE — only extends TTL if the lock value matches.
 * Prevents extending a lock that was already taken over by another process.
 */
const EXTEND_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Acquire a distributed agent lock for a phone.
 * Uses Redis SET NX with 30s TTL + heartbeat extension every 10s.
 * Returns a UUID lock value if acquired (used for ownership-safe release),
 * or null if the lock is already held.
 *
 * Lock keyed by phoneHash (not sessionId) to prevent concurrent agent runs
 * when session rotates mid-conversation.
 */
export async function acquireAgentLock(phoneHash: string): Promise<string | null> {
  const redis = await getRedisClient();
  const key = rk(`wa:agent:${phoneHash}`);
  const lockValue = randomUUID();

  const acquired = await redis.set(key, lockValue, { EX: AGENT_LOCK_TTL_SECONDS, NX: true });
  if (!acquired) return null;

  // Start heartbeat to extend TTL during long LLM calls — ownership-checked
  const interval = setInterval(async () => {
    try {
      await redis.eval(EXTEND_LOCK_SCRIPT, {
        keys: [key],
        arguments: [lockValue, String(AGENT_LOCK_TTL_SECONDS)],
      });
    } catch {
      // Redis may be down — lock will expire naturally
    }
  }, AGENT_LOCK_HEARTBEAT_MS);

  heartbeats.set(phoneHash, interval);
  return lockValue;
}

/**
 * Release the agent lock. Clears heartbeat and conditionally deletes Redis key
 * only if the lock value matches (ownership check via Lua script).
 *
 * Lock keyed by phoneHash (not sessionId).
 */
export async function releaseAgentLock(phoneHash: string, lockValue: string): Promise<void> {
  const interval = heartbeats.get(phoneHash);
  if (interval) {
    clearInterval(interval);
    heartbeats.delete(phoneHash);
  }

  try {
    const redis = await getRedisClient();
    const key = rk(`wa:agent:${phoneHash}`);
    await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [lockValue] });
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

// ── GPS location ───────────────────────────────────────────────────────────────

/**
 * Store the last GPS location shared by a customer in their session hash.
 * Overwrites previous location — only the most recent pin is kept.
 */
export async function storeLastLocation(hash: string, lat: number, lng: number): Promise<void> {
  const redis = await getRedisClient();
  const key = rk(`wa:phone:${hash}`);
  await redis.hSet(key, { lastLat: String(lat), lastLng: String(lng) });
}

/**
 * Read the last GPS location from a session hash, if any.
 */
export async function getLastLocation(
  hash: string,
): Promise<{ lat: number; lng: number } | null> {
  const redis = await getRedisClient();
  const key = rk(`wa:phone:${hash}`);
  const [latStr, lngStr] = await Promise.all([
    redis.hGet(key, "lastLat"),
    redis.hGet(key, "lastLng"),
  ]);
  if (!latStr || !lngStr) return null;
  const lat = Number.parseFloat(latStr);
  const lng = Number.parseFloat(lngStr);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
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

// ── Message deduplication ────────────────────────────────────────────────────

const DEDUP_TTL_SECONDS = 300; // 5 minutes — covers WhatsApp retries (up to ~60s)

/**
 * Check if a message was already processed. Uses SHA-256 hash of
 * phoneHash + messageBody to detect WhatsApp retries (which send
 * the same payload after 30+ seconds, bypassing the 2s debounce).
 *
 * Returns true if the message is a duplicate (should be skipped).
 */
export async function isMessageDuplicate(
  phoneHash: string,
  messageBody: string,
): Promise<boolean> {
  const hash = createHash("sha256")
    .update(`${phoneHash}:${messageBody}`)
    .digest("hex")
    .slice(0, 16);
  const redis = await getRedisClient();
  const key = rk(`wa:dedup:${hash}`);
  const result = await redis.set(key, "1", { EX: DEDUP_TTL_SECONDS, NX: true });
  // NX returns "OK" on success (first time), null if key already exists (duplicate)
  return result !== "OK";
}

// ── LGPD opt-in tracking ────────────────────────────────────────────────────

/** Check if a phone (by hash) has already accepted the LGPD opt-in disclosure. */
export async function hasOptedIn(phoneHash: string): Promise<boolean> {
  const redis = await getRedisClient();
  const value = await redis.get(rk(`wa:optin:${phoneHash}`));
  return !!value;
}

/** Record that a phone (by hash) has accepted the LGPD opt-in disclosure. No TTL — permanent. */
export async function markOptedIn(phoneHash: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(rk(`wa:optin:${phoneHash}`), "1");
}

// ── Welcome credit ────────────────────────────────────────────────────────────

/**
 * Store a welcome credit coupon code for a new customer.
 * TTL: 30 days — coupon expires if not used.
 *
 * NOTE: The coupon code "BEMVINDO15" must be created in Medusa admin before use.
 */
export async function setWelcomeCredit(customerId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(rk(`welcome:credit:${customerId}`), "BEMVINDO15", { EX: 30 * 86400 });
}

/**
 * Retrieve and atomically consume the welcome credit for a customer.
 * Returns the coupon code if available, null if already used or not set.
 * Uses GETDEL for atomic read-and-delete to prevent double-apply race.
 *
 * NOTE: packages/tools/src/intelligence/welcome-credit.ts has a similar
 * function that also needs the same GETDEL fix (outside this file's ownership).
 */
export async function getAndConsumeWelcomeCredit(customerId: string): Promise<string | null> {
  const redis = await getRedisClient();
  const code = await redis.getDel(rk(`welcome:credit:${customerId}`));
  return code;
}
