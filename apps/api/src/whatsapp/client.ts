// WhatsApp client — send text messages via Twilio.
//
// Singleton Twilio client, auto-splits at 4096 chars. All sends are routed
// through a shared Redis-backed send-rate limiter (Twilio per-second cap) and a
// client-side idempotency guard, then retried ONLY on provably non-delivering
// errors — never on a post-send-ambiguous timeout (which could double-bill).
// All sends log phone hash, never raw phone numbers.
//
// ── Audit-2026-05-23 — kernel-gated Twilio egress ─────────────────────────
//
// The two `messages.create` call sites (sendSingleMessage + sendMedia)
// route through `twilioAdjudicated.messages.create()` so each outbound
// WhatsApp send produces an audit record and is governed by the
// inline policy bundle in `packages/tools/src/twilio/adjudicated.ts`.
// The rate limiter + idempotency guard sit OUTSIDE that kernel gate (they are
// client-side delivery concerns, not adjudication), wrapping the adjudicated
// call in the shared `createMessage` retry loop.

import { createHash } from "node:crypto";
import twilio from "twilio";
import {
  mintRenderedReply,
  mintBroadcastReply,
  unwrapRendered,
  type RenderedReply,
} from "@adjudicate/core";
import {
  twilioAdjudicated,
  TwilioAdjudicateRefusedError,
  getRedisClient,
  rk,
} from "@ibatexas/tools";
import { getAuditSink } from "@ibatexas/audit-sink";
import logger from "../lib/logger.js";
import { recordOutboundSid } from "./delivery-store.js";
import { hashPhone } from "./session.js";

/** Compute retry delay: uses Retry-After header for 429, exponential backoff otherwise. */
function getRetryDelay(err: unknown, attempt: number): number {
  const status = (err as { status?: number }).status;
  if (status === 429) {
    const retryAfter = (err as { headers?: Record<string, string> }).headers?.["retry-after"];
    const retryMs = retryAfter ? Number(retryAfter) * 1000 : 5000;
    return Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 5000;
  }
  return 200 * 2 ** attempt;
}

// ── Retry classification ─────────────────────────────────────────────────────
//
// P1-NET-WASEND: the Twilio Messages endpoint is NOT server-side idempotent
// (unlike Call Payments, it has no Idempotency-Key support), and the SDK runs
// with a 10s client timeout. So a thrown error falls into two buckets:
//
//   1. The request *completed* and Twilio responded with an HTTP error
//      (RestException carries a numeric `.status`). Twilio answered but did not
//      accept/deliver → retrying cannot double-send. Safe to retry on 429 / 5xx.
//
//   2. The request *did not complete* — a client-side timeout or transport
//      error (raw axios error, no `.status`, identified by `.code`). A timeout
//      (ECONNABORTED/ETIMEDOUT) is POST-SEND-AMBIGUOUS: Twilio may already have
//      accepted the message before our socket gave up, so retrying risks a
//      duplicate billable WhatsApp message. We must NOT retry these. Pure
//      connection-establishment failures (ECONNREFUSED/ENOTFOUND/EAI_AGAIN)
//      never reached Twilio, so they are safe to retry.

/** Network error codes where the request provably never reached Twilio (safe to retry). */
const NON_DELIVERING_NETWORK_CODES = new Set([
  "ECONNREFUSED", // nothing listening — connection never established
  "ENOTFOUND", // DNS failure — never left the host
  "EAI_AGAIN", // transient DNS failure — never left the host
]);

/** Timeout / abort codes: the request MAY have been delivered. Never retry. */
const POST_SEND_AMBIGUOUS_CODES = new Set([
  "ECONNABORTED", // axios client timeout (our 10s limit) — send may have landed
  "ETIMEDOUT", // socket timeout — send may have landed
]);

function errStatus(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

/**
 * True when the error happened AFTER the request may have been delivered, so a
 * retry could produce a duplicate billable message. Retrying is forbidden here.
 */
function isPostSendAmbiguous(err: unknown): boolean {
  // A completed HTTP response (has numeric status) is never ambiguous — Twilio
  // answered, so we know whether it accepted the message.
  if (typeof errStatus(err) === "number") return false;
  const code = errCode(err);
  return code !== undefined && POST_SEND_AMBIGUOUS_CODES.has(code);
}

/**
 * True for errors known NOT to have delivered the message, where a retry is
 * safe: explicit 429, 5xx HTTP responses (Twilio answered but did not accept),
 * and connection-establishment failures that never reached Twilio.
 */
function isSafeToRetry(err: unknown): boolean {
  const status = errStatus(err);
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  // No HTTP status → transport error. Only retry codes that provably never
  // reached Twilio; anything else (incl. timeouts) is treated as unsafe.
  const code = errCode(err);
  return code !== undefined && NON_DELIVERING_NETWORK_CODES.has(code);
}

// ── Idempotency guard ─────────────────────────────────────────────────────────
//
// Since the Messages endpoint has no server-side dedup, we enforce it
// client-side: each logical send gets a deterministic key, claimed in Redis via
// SET NX before the create. If a send is post-send-ambiguous (timeout) we leave
// the claim in place, so a later retry/redelivery of the same logical message is
// suppressed rather than re-billed. Fail-OPEN if Redis is unavailable: an
// outage of the dedup store must never block a legitimate alert.

const IDEMPOTENCY_TTL_SECONDS = 300; // 5 min — covers SDK timeout + caller retries

/**
 * Deterministic idempotency key for one logical message: same recipient + body
 * (+ media) + part index always yields the same key, so a retry reuses it.
 */
function idempotencyKey(
  from: string,
  to: string,
  body: string,
  part: number,
  mediaUrl?: string,
): string {
  const digest = createHash("sha256")
    .update(`${from}\x00${to}\x00${mediaUrl ?? ""}\x00${part}\x00${body}`)
    .digest("hex");
  return `wa:send:idem:${digest}`;
}

/**
 * Claim an idempotency key. Returns true if this caller owns the send (first
 * claim), false if it was already claimed (duplicate — skip the create).
 * Fail-open: returns true when Redis is unavailable so a real send is never
 * dropped because the dedup store is down.
 */
async function claimIdempotencyKey(key: string): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const res = await redis.set(rk(key), "1", { EX: IDEMPOTENCY_TTL_SECONDS, NX: true });
    return res === "OK";
  } catch (err) {
    logger.warn({ error: String(err) }, "[whatsapp.idempotency.degraded]");
    return true; // fail-open — never block a send on the dedup store
  }
}

// ── Twilio client (singleton) ─────────────────────────────────────────────────

let _client: ReturnType<typeof twilio> | null = null;

function getTwilioClient(): ReturnType<typeof twilio> {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !auth) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
    // 10s timeout prevents indefinite hangs during Twilio API outages
    _client = twilio(sid, auth, { timeout: 10_000 });
  }
  return _client;
}

export function getWhatsAppNumber(): string {
  const num = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!num) throw new Error("TWILIO_WHATSAPP_NUMBER not set");
  return num;
}

// Re-export hashPhone as phoneHash for backward compatibility
export { hashPhone as phoneHash } from "./session.js";

/**
 * Reduce a media URL to its origin (scheme + host) for logging. The path and
 * query string can embed customer/order identifiers or signed access tokens
 * (LGPD: PII not logged outside the audit ledger), so we drop them.
 */
function mediaUrlHost(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid_url";
  }
}

// ── Message splitting ──────────────────────────────────────────────────────────

const MAX_WHATSAPP_LENGTH = 4096;

/**
 * Find the best split index in a chunk of text.
 * Prefers sentence boundaries (.!?), then newline, then space, then hard split.
 */
function findSplitIndex(chunk: string): number {
  // Prefer sentence boundary (search backwards from end to midpoint)
  for (let i = chunk.length - 1; i > MAX_WHATSAPP_LENGTH * 0.5; i--) {
    if (chunk[i] === "." || chunk[i] === "!" || chunk[i] === "?") {
      return i + 1;
    }
  }

  // Fallback to newline
  const newlineIdx = chunk.lastIndexOf("\n");
  if (newlineIdx !== -1) return newlineIdx + 1;

  // Fallback to space
  const spaceIdx = chunk.lastIndexOf(" ");
  if (spaceIdx !== -1) return spaceIdx + 1;

  // Hard split as last resort
  return MAX_WHATSAPP_LENGTH;
}

/**
 * Split a {@link RenderedReply} at sentence boundaries (`.!?`), then newline,
 * then space. If split, each part is prefixed with `(1/N)`.
 *
 * EGRESS BRAND (Plan 1 / Theorem E-1): the string is extracted once (after
 * proving provenance via `unwrapRendered`), split, and every substring is
 * re-minted via `mintRenderedReply` so the brand is preserved across the split
 * — egress downstream still receives only branded values.
 */
export function splitForWhatsApp(reply: RenderedReply): RenderedReply[] {
  const text = unwrapRendered(reply);
  if (text.length <= MAX_WHATSAPP_LENGTH) return [mintRenderedReply(text)];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_WHATSAPP_LENGTH) {
    const chunk = remaining.slice(0, MAX_WHATSAPP_LENGTH);
    const splitIdx = findSplitIndex(chunk);

    parts.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) parts.push(remaining);

  // Add part indicators
  if (parts.length > 1) {
    return parts.map((p, i) => mintRenderedReply(`(${i + 1}/${parts.length})\n${p}`));
  }
  return parts.map((p) => mintRenderedReply(p));
}

// ── Shared send-rate limiter ─────────────────────────────────────────────────
//
// P1-SCALE-TWILIORATE: jobs, every subscriber alert path, and the PIX monitor
// all send through ONE Twilio number. With only per-message typing delays there
// is no cross-process coordination, so concurrent bursts blow past Twilio's
// per-second cap → 429s + dropped messages. This is a proactive, Redis-backed
// token bucket keyed by the SENDING number (the shared resource), awaited before
// every messages.create so all processes throttle against the same budget.
//
// Rate is env-configurable; default 10 msg/s is a safe floor below Twilio's
// WhatsApp throughput. Fail-OPEN if Redis is down — a limiter outage must never
// hard-fail a legitimate send (e.g. a PIX-expiry alert).

/** Sustained send rate (tokens/sec) per Twilio number. Override via env. */
const SEND_RATE_PER_SECOND = Number(process.env.WHATSAPP_SEND_RATE_PER_SECOND) || 10;
/** Bucket capacity (max burst). Defaults to one second of tokens. */
const SEND_RATE_BURST =
  Number(process.env.WHATSAPP_SEND_RATE_BURST) || SEND_RATE_PER_SECOND;
/** Max time to wait for a token before proceeding anyway (avoids unbounded stalls). */
const SEND_RATE_MAX_WAIT_MS = 10_000;

/**
 * Atomic token-bucket refill+consume in a single Lua eval (no INCR/EXPIRE race).
 * State: a hash { tokens, ts } at KEYS[1]. ARGV: rate, burst, nowMs.
 * Returns { allowed (1/0), waitMs } — waitMs is the time until one token frees up.
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = burst end
if ts == nil then ts = now end

-- refill based on elapsed time
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(burst, tokens + elapsed * rate)

local allowed = 0
local waitMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  waitMs = math.ceil((1 - tokens) / rate * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- TTL just long enough to refill a full bucket from empty, so idle keys expire
redis.call('PEXPIRE', key, math.ceil(burst / rate * 1000) + 1000)
return {allowed, waitMs}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Block until a send token is available for `from` (the Twilio number). Polls
 * the shared Redis token bucket, sleeping for the bucket-reported wait between
 * attempts, up to SEND_RATE_MAX_WAIT_MS total. Fail-OPEN: any Redis error logs
 * and returns immediately so the send proceeds.
 */
async function acquireSendToken(from: string): Promise<void> {
  const key = rk(`wa:send:rate:${from}`);
  const deadline = Date.now() + SEND_RATE_MAX_WAIT_MS;

  for (;;) {
    let allowed = 1;
    let waitMs = 0;
    try {
      const redis = await getRedisClient();
      const res = (await redis.eval(TOKEN_BUCKET_SCRIPT, {
        keys: [key],
        arguments: [String(SEND_RATE_PER_SECOND), String(SEND_RATE_BURST), String(Date.now())],
      })) as [number, number];
      allowed = Number(res[0]);
      waitMs = Number(res[1]);
    } catch (err) {
      // Fail-open: never block a send because the limiter's Redis is down.
      logger.warn({ error: String(err) }, "[whatsapp.ratelimit.degraded]");
      return;
    }

    if (allowed === 1) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Budget exhausted longer than our patience — proceed and let Twilio's own
      // 429 handling (retry-after) absorb it rather than dropping the message.
      logger.warn({ from }, "[whatsapp.ratelimit.timeout]");
      return;
    }
    await sleep(Math.min(waitMs > 0 ? waitMs : 50, remaining));
  }
}

// ── Send helpers ───────────────────────────────────────────────────────────────

/**
 * LE2-030 — optional correlation carried alongside a send so the captured
 * Twilio SID can be joined back to the conductor turn that produced the reply.
 *
 * OPTIONAL by design: most send call sites (jobs, subscriber alerts, the PIX
 * expiry monitor) have no conductor turn at all. Those sends are still recorded
 * — with a NULL `turn_id` — so the undelivered query covers every outbound
 * message, not just conversational replies.
 */
export interface SendCorrelation {
  /** `capsule.turnId` — the RCA workbench's join key. */
  readonly turnId?: string | null;
  /** The conversation/session id (turn_trace.conversation_id). */
  readonly conversationId?: string | null;
}

/**
 * Send a text message, auto-splitting if >4096 chars.
 * Retries up to 3x; never on a post-send-ambiguous timeout.
 */
export async function sendText(
  to: string,
  body: RenderedReply,
  correlation?: SendCorrelation,
): Promise<void> {
  const parts = splitForWhatsApp(body);
  const hash = hashPhone(to.replace("whatsapp:", ""));

  for (let i = 0; i < parts.length; i++) {
    // Typing simulation: 600ms delay before first part
    if (i === 0) await sleep(600);
    // 200ms delay between subsequent parts to preserve order
    if (i > 0) await sleep(200);

    await sendSingleMessage(to, parts[i], hash, i, correlation);
  }

  logger.info({ phone_hash: hash, parts_count: parts.length }, "[whatsapp.send]");
}

/**
 * LE2-030 — pull the Twilio message SID out of the SDK's `MessageInstance`.
 * The adjudicated wrapper types the return as `unknown` (the SDK shape flows
 * through unchanged), so read it structurally. Returns null for any shape that
 * does not carry a plausible SID rather than inventing one — a fabricated
 * correlation key is worse than an absent one.
 */
function extractMessageSid(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const sid = (result as { sid?: unknown }).sid;
  return typeof sid === "string" && sid.length > 0 ? sid : null;
}

/**
 * Core sender shared by sendText/sendMedia. Routes through the proactive rate
 * limiter and a client-side idempotency guard, then sends via the kernel-gated
 * `twilioAdjudicated.messages.create` and retries ONLY on provably non-delivering
 * errors (never on a post-send-ambiguous timeout, and never on a kernel REFUSE).
 *
 * @param part  Index of this part within a logical message (for the idempotency
 *              key — split parts are distinct messages and must each be sent).
 * @param ctx   Log namespace + the adjudication metadata for this send.
 *
 * LE2-030: the ONLY addition to this path is SID capture after a successful
 * create — no new retry rule, no new send, no change to the create payload.
 * The capture is fully fail-open (`recordOutboundSid` swallows its own errors),
 * so a delivery-store outage leaves sending byte-for-byte as it was.
 */
async function createMessage(
  params: { from: string; to: string; body?: RenderedReply; mediaUrl?: string[] },
  hash: string,
  part: number,
  ctx: {
    logTag: string;
    sourceSubject: string;
    reason: string;
    correlation?: SendCorrelation;
  },
): Promise<void> {
  const { from, to } = params;
  // The idempotency hash is computed over the underlying string; unwrap (which
  // also asserts provenance) for the digest only. The branded value flows on to
  // the SITE-4 chokepoint unchanged.
  const idemKey = idempotencyKey(
    from,
    to,
    params.body ? unwrapRendered(params.body) : "",
    part,
    params.mediaUrl?.[0],
  );

  // Client-side dedup: if this exact logical send was already claimed (e.g. a
  // prior attempt timed out post-send), skip the create to avoid double-billing.
  if (!(await claimIdempotencyKey(idemKey))) {
    logger.warn({ phone_hash: hash, part }, `[whatsapp.${ctx.logTag}.deduped]`);
    return;
  }

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Proactive shared rate limit (awaited before every create).
    await acquireSendToken(from);
    try {
      const result = await twilioAdjudicated.messages.create(params, {
        sourceSubject: ctx.sourceSubject,
        reason: ctx.reason,
        auditSink: getAuditSink(),
      });
      // LE2-030 — persist the SID for this accepted part, correlated to the
      // turn. AWAITED (not fire-and-forget) so the row exists before Twilio's
      // first status callback can arrive: a callback for a not-yet-written SID
      // would be an unrecoverable no-op. The write never throws.
      const sid = extractMessageSid(result);
      if (sid !== null) {
        await recordOutboundSid({
          messageSid: sid,
          turnId: ctx.correlation?.turnId ?? null,
          conversationId: ctx.correlation?.conversationId ?? null,
          partIndex: part,
          phoneHash: hash,
          source: ctx.logTag,
          sentAt: new Date().toISOString(),
        });
      } else {
        logger.warn(
          { phone_hash: hash, part },
          `[whatsapp.${ctx.logTag}.no_sid] send accepted but no SID on the response — delivery unverifiable`,
        );
      }
      return;
    } catch (err) {
      // Kernel REFUSE is permanent — retrying would emit a fresh audit record
      // per attempt (3× pollution) for a payload that will never be approved.
      if (err instanceof TwilioAdjudicateRefusedError) {
        logger.warn(
          { phone_hash: hash, code: err.code },
          `[whatsapp.${ctx.logTag}.refused] kernel refusal, not retrying`,
        );
        throw err;
      }

      const isLast = attempt === maxRetries - 1;
      logger.error(
        { phone_hash: hash, attempt: attempt + 1, maxRetries, error: String(err) },
        `[whatsapp.${ctx.logTag}.error]`,
      );

      // Post-send-ambiguous (timeout): Twilio may already have the message.
      // Retrying risks a duplicate billable send, and the idempotency claim is
      // intentionally left in place so any redelivery is suppressed. Bail out.
      if (isPostSendAmbiguous(err)) {
        logger.warn({ phone_hash: hash }, `[whatsapp.${ctx.logTag}.timeout_no_retry]`);
        throw err;
      }
      // Only retry errors known not to have delivered (429 / 5xx / connect fail).
      if (isLast || !isSafeToRetry(err)) throw err;

      // Respect Twilio 429 Retry-After header; exponential backoff otherwise.
      await sleep(getRetryDelay(err, attempt));
    }
  }
}

async function sendSingleMessage(
  to: string,
  body: RenderedReply,
  hash: string,
  part: number,
  correlation?: SendCorrelation,
): Promise<void> {
  // Touch the legacy client factory so a missing TWILIO_* env is surfaced
  // before the kernel-gated send is attempted (preserves the original
  // fail-fast posture in apps/api startup).
  getTwilioClient();
  await createMessage(
    { from: getWhatsAppNumber(), to, body },
    hash,
    part,
    {
      logTag: "send",
      sourceSubject: "whatsapp:sendText",
      reason: "send-text",
      ...(correlation !== undefined ? { correlation } : {}),
    },
  );
}

/**
 * Send an interactive list message via Twilio Content API.
 * Uses `contentVariables` with a pre-created Content Template,
 * or falls back to numbered text if not configured / fails.
 */
export async function sendInteractiveList(
  to: string,
  body: RenderedReply,
  _buttonText: string,
  sections: InteractiveSection[],
): Promise<void> {
  // EGRESS BRAND (Plan 1 / F4): the customer-facing `body` is minted by the
  // CALLER (the producer) and arrives as a `RenderedReply`; this function never
  // mints unvalidated customer prose. The numbered-list scaffolding below
  // (section titles, row numbers) is fixed, operator-shaped UI — not
  // customer-prose — so the COMPOSED text is (re-)minted via the broadcast
  // operational minter just before egress.
  //
  // Interactive messages via Twilio require pre-registered Content Templates (contentSid).
  // Until templates are approved in production, send as formatted numbered text.
  const lines: string[] = [unwrapRendered(body), ""];

  let counter = 1;
  for (const section of sections) {
    if (section.title) lines.push(`*${section.title}*`);
    for (const row of section.rows) {
      const desc = row.description ? ` — ${row.description}` : "";
      lines.push(`${counter}️⃣ ${row.title}${desc}`);
      counter++;
    }
    lines.push("");
  }

  // Templated interactive menu (deterministic, operator-shaped) → branded via
  // the broadcast operational minter before egress.
  await sendText(to, mintBroadcastReply(lines.join("\n").trimEnd()));
}

/**
 * Send an interactive button message via Twilio Content API.
 * Falls back to formatted text with labeled options.
 */
export async function sendInteractiveButtons(
  to: string,
  body: RenderedReply,
  buttons: InteractiveButton[],
): Promise<void> {
  // EGRESS BRAND (Plan 1 / F4): the customer-facing `body` is minted by the
  // CALLER and arrives as a `RenderedReply`. The button labels + the
  // "Responda com a opção desejada" prompt are fixed operator-shaped UI, so the
  // composed text is (re-)minted via the broadcast operational minter at egress.
  //
  // Until Twilio Content Templates are approved, send as formatted text.
  const buttonLabels = buttons.map((b) => `▸ *${b.title}*`).join("\n");
  await sendText(
    to,
    mintBroadcastReply(
      `${unwrapRendered(body)}\n\n${buttonLabels}\n\n_Responda com a opção desejada._`,
    ),
  );
}

/**
 * Send a media message (image, PDF, etc.) via Twilio's mediaUrl parameter.
 * Optionally includes a text body alongside the media.
 * Routes through the shared rate limiter + idempotency guard; retries only on
 * provably non-delivering errors (never on a post-send-ambiguous timeout).
 */
export async function sendMedia(
  to: string,
  mediaUrl: string,
  body?: RenderedReply,
  correlation?: SendCorrelation,
): Promise<void> {
  // EGRESS BRAND (Plan 1 / F4): the optional customer-facing caption `body` is
  // minted by the CALLER (the producer) and arrives as a `RenderedReply`; this
  // function never mints unvalidated customer prose internally.
  //
  // Touch the legacy client factory so a missing TWILIO_* env is surfaced
  // before the kernel-gated send is attempted.
  getTwilioClient();
  const from = getWhatsAppNumber();
  const hash = hashPhone(to.replace("whatsapp:", ""));

  await createMessage(
    { from, to, mediaUrl: [mediaUrl], ...(body ? { body } : {}) },
    hash,
    0,
    {
      logTag: "sendMedia",
      sourceSubject: "whatsapp:sendMedia",
      reason: "send-media",
      ...(correlation !== undefined ? { correlation } : {}),
    },
  );
  logger.info({ phone_hash: hash, media_url_host: mediaUrlHost(mediaUrl) }, "[whatsapp.sendMedia]");
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InteractiveRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveSection {
  title?: string;
  rows: InteractiveRow[];
}

export interface InteractiveButton {
  id: string;
  title: string;
}
