// WhatsApp webhook handler — Twilio incoming message webhook (WS7 cutover).
//
// IMPORTANT: This plugin registers a custom content type parser for
// application/x-www-form-urlencoded on the webhook path, similar to how
// stripe-webhook.ts handles raw body parsing for signature verification.
//
// Security:
//   - Twilio signature verification via twilio.validateRequest()
//   - Uses TWILIO_AUTH_TOKEN + TWILIO_WEBHOOK_URL
// Idempotency:
//   - SET rk('wa:webhook:{MessageSid}') 1 EX 86400 NX (24h)
//   - Duplicate messages return 200 immediately with no side-effects
// Rate limiting:
//   - 20 msgs/min per phone via rk('wa:rate:{phoneHash}') INCR + EXPIRE 60
// Debounce:
//   - 2s window via rk('wa:debounce:{phoneHash}') NX to batch rapid-fire messages
//
// WS7 — the conversational orchestration was `runOrchestrator(...)` (a
// StreamChunk generator collected by `collectAgentResponse`). It is now the
// claustrum Conductor:
//
//   conductor.openCapsule({ channel: "whatsapp", customerId, sessionKey, inbound })
//   handleTurn(capsule, inbound) → TurnResult { response, decision, acted, ... }
//
// `runConductorTurn` below adapts the TurnResult back into the dev
// `{ text, pixData }` shape so EVERY downstream WhatsApp feature (PIX
// copia-e-cola + QR + expiry monitor, append-to-session, post-lock retry,
// status logging) is preserved byte-for-byte. We do NOT delegate to
// `WhatsAppChannel.render` — that adapter only sends chunked text and would
// drop dev's PIX media, status suppression, and per-message logging.

import { parse as parseQuerystring } from "node:querystring";
import type { FastifyInstance, FastifyRequest } from "fastify";
import twilio from "twilio";
import { handleTurn, type ChannelMessage } from "@claustrum/core";
import {
  mintBroadcastReply,
  mintFallbackReply,
  mintReceiptReply,
  wrapLegacyResponderText,
} from "@adjudicate/core";
import { getRedisClient, rk, atomicIncr } from "@ibatexas/tools";
import { getConductor } from "../claustrum-bootstrap.js";
import { isSessionPausedForHuman } from "../escalation/escalation-store.js";
import { loadSession, appendMessages } from "../session/store.js";
import {
  normalizePhone,
  hashPhone,
  resolveWhatsAppSession,
  touchSession,
  acquireAgentLock,
  releaseAgentLock,
  tryDebounce,
  hasOptedIn,
  markOptedIn,
  setWelcomeCredit,
  storeLastLocation,
  getLastLocation,
} from "../whatsapp/session.js";
import { sendText, sendMedia } from "../whatsapp/client.js";
import {
  classifyTurnDelivery,
  classifyCatchError,
  emitNoDelivery,
  openIncidentInline,
  type TurnDisposition,
} from "../conversation/no-delivery.js";
import { closeIncidentOnDeliveredReply } from "../incidents/incident-auto-close.js";
import { matchShortcut, buildHelpText, buildWelcomeText } from "../whatsapp/shortcuts.js";
import { LGPD_OPTIN_MESSAGE } from "../whatsapp/constants.js";
import { scheduleHesitationNudge, markCustomerReplied } from "../jobs/hesitation-nudge.js";
import { schedulePixExpiryMonitor } from "../jobs/pix-expiry-monitor.js";

const MAX_RATE_PER_MINUTE = 20;
const DEBOUNCE_MS = 2000;
const MAX_HISTORY_MESSAGES = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type LogFn = { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

// ── WhatsApp turn result (dev-shaped) ────────────────────────────────────────
//
// The fields the WhatsApp feature code reads from a turn. `runConductorTurn`
// maps the claustrum `TurnResult` onto this so the PIX + append + retry paths
// stay identical to the pre-cutover `collectAgentResponse` consumer.
interface WhatsAppTurn {
  readonly text: string;
  /**
   * REQUIRED — the compile-time guard forcing every return path to classify its
   * delivery outcome. Distinguishes the intentional bot-pause `{text:""}` from a
   * byte-identical empty model completion (the no-reply incident discriminator).
   */
  readonly disposition: TurnDisposition;
  /** `capsule.turnId` — dedup + audit correlation (absent on the pause path). */
  readonly turnId?: string;
  /** `turn.decision.kind` — an `ESCALATE` handoff is never a drop. */
  readonly decisionKind?: string;
  readonly pixData?: {
    pixCopyPaste?: string;
    pixQrCode?: string;
    pixExpiresAt?: string;
    orderId?: string;
  };
}

// ── Guest-marker convention (mirrors register-ibatexas-tool-packs) ────────────
const GUEST_ID_PREFIXES = ["guest:", "anon:", "anonymous:"] as const;
function isGuestCustomerId(id: string | null | undefined): boolean {
  if (!id) return true;
  const trimmed = id.trim();
  if (trimmed === "") return true;
  return GUEST_ID_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * Extract PIX artifacts from a completed turn.
 *
 * The ibatexas responder (`createIbatexasResponder`) does NOT copy tool output
 * onto `RenderedResponse.artifacts`, so PIX copia-e-cola / QR are NOT in
 * `turn.response.artifacts`. They DO live in `turn.acted` — the dispatch
 * result of the executed checkout / regenerate-PIX tool (`createCheckout` /
 * `regeneratePix` return `{ pixCopyPaste, pixQrCode, pixExpiresAt, orderId }`).
 * We read them from there, scanning both the single-execution and
 * multi-envelope-plan shapes. Best-effort: a turn that ran no PIX tool yields
 * undefined and the PIX follow-up block is skipped.
 */
function extractPixData(acted: unknown): WhatsAppTurn["pixData"] | undefined {
  const fromResult = (result: unknown): WhatsAppTurn["pixData"] | undefined => {
    if (result === null || typeof result !== "object") return undefined;
    const r = result as Record<string, unknown>;
    const pixCopyPaste = typeof r.pixCopyPaste === "string" ? r.pixCopyPaste : undefined;
    const pixQrCode = typeof r.pixQrCode === "string" ? r.pixQrCode : undefined;
    const pixExpiresAt = typeof r.pixExpiresAt === "string" ? r.pixExpiresAt : undefined;
    const orderId = typeof r.orderId === "string" ? r.orderId : undefined;
    if (!pixCopyPaste && !pixQrCode) return undefined;
    return { pixCopyPaste, pixQrCode, pixExpiresAt, orderId };
  };

  if (acted === null || typeof acted !== "object") return undefined;
  const a = acted as { kind?: string; result?: unknown; executions?: ReadonlyArray<{ result?: unknown }> };
  if (a.kind === "executed" || a.kind === "rewritten_and_executed") {
    return fromResult(a.result);
  }
  if (a.kind === "executed_plan" && Array.isArray(a.executions)) {
    for (const exec of a.executions) {
      const pix = fromResult(exec.result);
      if (pix) return pix;
    }
  }
  return undefined;
}

/**
 * Run ONE conductor turn for a WhatsApp message and adapt it into the dev
 * `{ text, pixData }` shape. Replaces `collectAgentResponse(runOrchestrator(...))`.
 *
 * `customerId` is the conductor identity (a guest marker if the session has no
 * real customer id); `sessionKey` is dev's session id. The conductor loads
 * memory + resolves tenant/policy itself; we hand it the normalized inbound
 * message. The lock is already held by the caller, and the synchronous 200 was
 * already sent — so this can take as long as the model needs.
 */
async function runConductorTurn(args: {
  input: string;
  customerId: string;
  sessionKey: string;
  log: LogFn;
}): Promise<WhatsAppTurn> {
  // D2 bot-pause gate: when a human has taken over this session (open
  // escalation), suppress the bot reply. Empty text → the caller sends nothing
  // (every WhatsApp send is guarded by `if (response.text)`). Fail-open.
  if (await isSessionPausedForHuman(args.sessionKey)) {
    args.log.info(
      { session: args.sessionKey },
      "[whatsapp] session paused for human takeover — bot reply suppressed",
    );
    return { text: "", disposition: "suppressed_paused" };
  }

  const conductor = getConductor();
  const inbound: ChannelMessage = {
    channel: "whatsapp",
    customerId: args.customerId,
    conversationId: args.sessionKey,
    text: args.input,
    receivedAt: new Date().toISOString(),
    locale: "pt-BR",
  };
  const capsule = await conductor.openCapsule({
    channel: "whatsapp",
    customerId: args.customerId,
    sessionKey: args.sessionKey,
    inbound,
  });
  try {
    const turn = await handleTurn(capsule, inbound);
    const pixData = extractPixData(turn.acted);
    // Classify the delivery outcome at the source (the only place that can tell
    // an empty completion from a whitespace-only one). The pause early-return
    // above is the only `suppressed_paused`; everything here is a real turn.
    const rawText = turn.response.text ?? "";
    const disposition: TurnDisposition =
      rawText.length === 0
        ? "empty_completion"
        : rawText.trim() === ""
          ? "whitespace_only"
          : "deliverable";
    return {
      text: rawText,
      disposition,
      turnId: capsule.turnId,
      decisionKind: turn.decision.kind,
      ...(pixData ? { pixData } : {}),
    };
  } finally {
    await conductor.closeCapsule(capsule);
  }
}

/**
 * Post-lock re-check: if new user messages arrived while the agent was running,
 * re-acquire lock and re-run agent once (max retry = 1 to prevent loops).
 */
async function retryForMissedMessages(
  session: { sessionId: string; customerId: string },
  hash: string,
  phone: string,
  log: LogFn,
): Promise<void> {
  const postHistory = await loadSession(session.sessionId);
  const lastMsg = postHistory.at(-1);
  if (lastMsg?.role !== "user") return;

  const retryLockValue = await acquireAgentLock(hash);
  if (!retryLockValue) return;

  try {
    const retryHistory = await loadSession(session.sessionId);
    const retryTrimmed = retryHistory.slice(-MAX_HISTORY_MESSAGES);
    const retryLastUser = [...retryTrimmed].reverse().find((m) => m.role === "user");
    const retryInput = retryLastUser?.content || "";

    log.info({ phone_hash: hash }, "[whatsapp.agent.retry] Re-running agent for missed messages");
    const retryConductorCustomerId = isGuestCustomerId(session.customerId)
      ? `guest:${session.sessionId}`
      : session.customerId;
    const retryResponse = await runConductorTurn({
      input: retryInput,
      customerId: retryConductorCustomerId,
      sessionKey: session.sessionId,
      log,
    });

    // Gate on a TRIMMED non-blank reply (M3) — mirrors classifyTurnDelivery's
    // notion of a real delivered reply. A whitespace-only completion ("\n") is
    // NOT a delivered reply: it must not be sent and must not auto-resolve the
    // OPEN incident; instead it falls through to the whitespace_only branch below.
    if (retryResponse.text && retryResponse.text.trim().length > 0) {
      await sendText(`whatsapp:${phone}`, wrapLegacyResponderText(retryResponse.text));
      await appendMessages(session.sessionId, [
        { role: "assistant", content: retryResponse.text },
      ], true, { customerId: session.customerId, channel: "whatsapp" });
      // Same-invocation self-heal: this best-effort second attempt delivered →
      // AUTO_RESOLVE any OPEN incident on the session (same delivered predicate;
      // this branch never sends PIX, so text-delivered is the predicate here).
      if (retryResponse.turnId) {
        await closeIncidentOnDeliveredReply(session.sessionId, retryResponse.turnId, log);
      }
    } else if (
      retryResponse.disposition === "empty_completion" ||
      retryResponse.disposition === "whitespace_only"
    ) {
      // Second-pass empty/whitespace (not paused, not ESCALATE) → retry_exhausted.
      // No `body.MessageSid` is in scope here; dedup on `retryResponse.turnId`.
      if (retryResponse.decisionKind !== "ESCALATE") {
        const signal = {
          sessionId: session.sessionId,
          cause: "retry_exhausted" as const,
          customerImpacted: true,
          channel: "whatsapp",
          customerId: session.customerId,
          senderRef: `whatsapp:${phone}`,
          phoneHash: hash,
          turnId: retryResponse.turnId ?? null,
          decisionKind: retryResponse.decisionKind ?? null,
        };
        await emitNoDelivery(signal, log);
        await openIncidentInline(signal, log);
      }
    }
  } catch (retryErr) {
    log.error(retryErr, "[whatsapp.agent.retry.error] Retry agent processing failed");
  } finally {
    await releaseAgentLock(hash, retryLockValue);
  }
}

interface TwilioWebhookBody {
  MessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  ProfileName?: string;
  // Interactive message response fields
  ButtonText?: string;
  ButtonPayload?: string;
  ListId?: string;
  ListTitle?: string;
  // Location pin fields (Twilio WhatsApp location messages)
  Latitude?: string;
  Longitude?: string;
}

// ── Webhook validation helpers ───────────────────────────────────────────────

interface SignatureError {
  code: number;
  error: string;
  logMessage: string;
}

function verifyTwilioSignature(
  request: FastifyRequest,
  body: TwilioWebhookBody,
): SignatureError | null {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  // D-AUTHURL: webhookUrl MUST be the exact public URL Twilio posted to — it is
  // hashed verbatim with the sorted POST params into X-Twilio-Signature. No proxy
  // rewrite, no extra query string, and http/https must match byte-for-byte, or
  // verifyTwilioSignature below rejects every request. The shape (no query, https
  // in prod) is asserted at startup in ../config.ts; see .env.example for the full
  // contract.
  const webhookUrl = process.env.TWILIO_WEBHOOK_URL;

  if (!authToken || !webhookUrl) {
    return { code: 500, error: "Webhook not configured", logMessage: "[whatsapp.config] TWILIO_AUTH_TOKEN or TWILIO_WEBHOOK_URL not set" };
  }

  const signature = request.headers["x-twilio-signature"];
  if (typeof signature !== "string") {
    return { code: 400, error: "Missing signature", logMessage: "[whatsapp.incoming] Missing X-Twilio-Signature" };
  }

  const isValid = twilio.validateRequest(authToken, signature, webhookUrl, body as Record<string, string>);
  if (!isValid) {
    return { code: 403, error: "Invalid signature", logMessage: "[whatsapp.incoming] Invalid Twilio signature" };
  }

  return null;
}

interface ParsedFields {
  messageSid: string;
  phone: string | null;
  hash: string;
}

function parseIncomingFields(body: TwilioWebhookBody): ParsedFields | null {
  const messageSid = body.MessageSid;
  const fromRaw = body.From;

  if (!messageSid || !fromRaw) return null;

  try {
    const phone = normalizePhone(fromRaw);
    const hash = hashPhone(phone);
    return { messageSid, phone, hash };
  } catch {
    return { messageSid, phone: null, hash: "" };
  }
}

// P2-SEC-WAIDEMPOTENCY: two-phase idempotency (mirrors the subscribers' withDedup
// and the Stripe webhook two-phase). The old guard SET the 24h key BEFORE the
// async turn, so any failure black-holed the MessageSid for 24h.
//   1. CLAIM   — SET NX with a SHORT in-flight TTL (before the 200). A Redis
//                error here FAILS CLOSED (caller returns 503 → Twilio retries).
//   2. RUN     — the async turn.
//   3a. CONFIRM — on success, promote to the full 24h dedup window.
//   3b. RELEASE — on failure, DEL the claim so Twilio's retry reprocesses
//                 (the short TTL is the backstop if the DEL itself fails).
const WA_DEDUP_TTL = 86400; // 24h — full dedup window (Twilio retry horizon)
const WA_INFLIGHT_TTL = 300; // 5 min — claim lifetime before the turn confirms

function webhookKey(messageSid: string): string {
  return rk(`wa:webhook:${messageSid}`);
}

type IdempotencyClaim = "claimed" | "duplicate" | "unavailable";

/** Phase 1 — claim the message with a short in-flight TTL. */
async function claimIdempotency(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  messageSid: string,
): Promise<IdempotencyClaim> {
  try {
    const wasSet = await redis.set(webhookKey(messageSid), "1", { EX: WA_INFLIGHT_TTL, NX: true });
    return wasSet ? "claimed" : "duplicate";
  } catch {
    return "unavailable";
  }
}

/** Phase 3a — promote the claim to the full dedup window on success. */
async function confirmProcessed(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  messageSid: string,
): Promise<void> {
  await redis.set(webhookKey(messageSid), "1", { EX: WA_DEDUP_TTL });
}

/** Phase 3b — release the claim so a Twilio retry can reprocess after failure. */
async function releaseClaim(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  messageSid: string,
): Promise<void> {
  await redis.del(webhookKey(messageSid));
}

// SEC-003: atomic INCR + EXPIRE via Lua to prevent immortal keys after crash
async function checkWebhookRateLimit(redis: Awaited<ReturnType<typeof getRedisClient>>, hash: string): Promise<boolean> {
  const rateKey = rk(`wa:rate:${hash}`);
  const rateCount = await atomicIncr(redis, rateKey, 60);
  return rateCount > MAX_RATE_PER_MINUTE;
}

// ── Shortcut dispatch ────────────────────────────────────────────────────────

async function handleShortcut(
  shortcutType: string,
): Promise<string | null> {
  switch (shortcutType) {
    case "help":
      return buildHelpText();
    case "welcome":
      return buildWelcomeText();
    case "menu":
      return null; // Fall through to agent (XState handles state)
    case "cart":
      return null; // Fall through to agent
    case "reservation":
      // Don't set state — just provide agent hint via prepended context
      return null; // Fall through to agent with reservation intent
    default:
      return null;
  }
}

// ── Build user message from interactive selections ───────────────────────────

function buildUserMessage(body: TwilioWebhookBody, messageBody: string): string {
  if (!body.ListId && !body.ButtonPayload) return messageBody;

  const selectionType = body.ListId ? "list" : "button";
  const selectionId = body.ListId || body.ButtonPayload;
  const selectionTitle = body.ListTitle || body.ButtonText || "";
  return `Usuário selecionou: ${selectionTitle}\n[interactive_selection: type=${selectionType}, id=${selectionId}]`;
}

export async function whatsappWebhookRoutes(server: FastifyInstance): Promise<void> {
  // Scope form-urlencoded parser to this route only (Fastify encapsulated plugin)
  await server.register(async function whatsappWebhookPlugin(scoped) {
    scoped.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer", bodyLimit: 1_048_576 },
      (_req, body, done) => {
        try {
          const parsed = parseQuerystring((body as Buffer).toString("utf-8"));
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    scoped.post(
    "/api/webhooks/whatsapp",
    {
      schema: {
        tags: ["webhooks"],
        summary: "Twilio WhatsApp incoming message webhook",
      },
    },
    async (request, reply) => {
      const body = request.body as TwilioWebhookBody;
      const startMs = Date.now();

      // ── 1. Verify Twilio signature ──────────────────────────────────────────
      const signatureError = verifyTwilioSignature(request, body);
      if (signatureError) {
        server.log.warn({ ip: request.ip }, signatureError.logMessage);
        return reply.code(signatureError.code).send({ error: signatureError.error });
      }

      // ── 2. Guard empty messages ─────────────────────────────────────────────
      const messageBody = body.Body?.trim() || "";
      const numMedia = Number.parseInt(body.NumMedia || "0", 10);
      const hasLocation = body.Latitude !== undefined && body.Longitude !== undefined;

      if (!messageBody && numMedia === 0 && !hasLocation) {
        return reply.code(200).type("text/xml").send("<Response/>");
      }

      // ── 3. Extract and validate fields ──────────────────────────────────────
      const parsed = parseIncomingFields(body);
      if (!parsed) {
        server.log.warn("[whatsapp.incoming] Missing MessageSid or From");
        return reply.code(400).send({ error: "Missing required fields" });
      }

      const { messageSid, phone, hash } = parsed;
      if (!phone) {
        server.log.warn({ from: body.From }, "[whatsapp.incoming] Invalid phone format");
        return reply.code(400).send({ error: "Invalid phone format" });
      }

      server.log.info(
        { phone_hash: hash, message_sid: messageSid, processing_ms: Date.now() - startMs },
        "[whatsapp.incoming] Message received",
      );

      // ── 4. Idempotency (BEFORE rate limit) — two-phase (P2-SEC-WAIDEMPOTENCY) ─
      const redis = await getRedisClient();
      const claim = await claimIdempotency(redis, messageSid);
      if (claim === "unavailable") {
        server.log.error({ message_sid: messageSid }, "[whatsapp] Idempotency claim unavailable — failing closed for Twilio retry");
        return reply.code(503).send({ error: "Service unavailable" });
      }
      if (claim === "duplicate") {
        server.log.info({ message_sid: messageSid }, "[whatsapp.duplicate] Already processed");
        return reply.code(200).type("text/xml").send("<Response/>");
      }

      // Content-based dedup removed — caused false positives for short repeated
      // words ("Sim" to add item, then "Sim" to confirm order = second silently
      // dropped). SID-based idempotency (step 4 above) is sufficient.

      // ── 5. Rate limit ──────────────────────────────────────────────────────
      const rateLimited = await checkWebhookRateLimit(redis, hash);
      if (rateLimited) {
        // Release the claim so a later (slowed) retry of the SAME message isn't
        // permanently black-holed by our in-flight marker (P2-SEC-WAIDEMPOTENCY).
        await releaseClaim(redis, messageSid).catch(() => {});
        server.log.warn({ phone_hash: hash }, "[whatsapp.rate] Rate limit exceeded");
        const rateSite = process.env.RESTAURANT_SITE_URL ?? "ibatexas.com.br";
        const ratePhone = process.env.RESTAURANT_PHONE ?? "";
        const rateMsg = ratePhone
          ? `Você está enviando mensagens rápido demais! 😅 Aguarde um momento ou acesse ${rateSite} / ligue ${ratePhone}`
          : `Você está enviando mensagens rápido demais! 😅 Aguarde um momento ou acesse ${rateSite}`;
        await sendText(`whatsapp:${phone}`, mintFallbackReply(rateMsg)).catch(() => {});
        return reply.code(429).type("text/xml").send("<Response/>");
      }

      // ── 6. Return 200 immediately ──────────────────────────────────────────
      void reply.code(200).type("text/xml").send("<Response/>");

      // ── 7. Async processing (decoupled from Fastify lifecycle) — owns Phase 3:
      //       promote the claim on success / release it on failure. ───────────
      void handleMessageAsync(body, messageSid, phone, hash, messageBody, numMedia, server.log).catch((err) => {
        server.log.error(err, "[whatsapp.agent.error] Unhandled error in async handler");
      });

      return reply;
    },
  );
  }); // end whatsappWebhookPlugin register
}

/** Try shortcut or state machine before resorting to LLM agent. Returns response text if handled. */
async function tryShortcutOrStateMachine(
  body: TwilioWebhookBody,
  messageBody: string,
  hash: string,
  phone: string,
  session: { sessionId: string; customerId?: string },
  log: LogFn,
): Promise<boolean> {
  const shortcut = matchShortcut(messageBody);
  if (shortcut) {
    log.info({ phone_hash: hash, shortcut: shortcut.type }, "[whatsapp.shortcut]");
    const response = await handleShortcut(shortcut.type);
    if (response) {
      await sendText(`whatsapp:${phone}`, mintBroadcastReply(response));
      await appendMessages(session.sessionId, [{ role: "assistant", content: response }], true, {
        customerId: session.customerId,
        channel: "whatsapp",
      });
      return true;
    }
  }

  // Legacy state machine removed — all flows handled by the conductor.
  return false;
}

// Max wall-clock for a single WhatsApp turn (P2-CONC-ABORT). A hung provider must
// not pin the turn open forever (Twilio already got its 200). Overridable via env
// (CLAUDE.md hard rule #3; documented in .env.example).
const WA_TURN_TIMEOUT_MS = Number.parseInt(process.env.WA_TURN_TIMEOUT_MS ?? "60000", 10);

// Flag-gated customer-facing holding message — the harm reducer when the bot
// produces no usable text (empty / whitespace completion). Sent STRICTLY AFTER
// classify+emit+open so a substitution bug can never mask incident emission.
// This is THE single empty/failure substitution at the send site (the merged
// "fix C"); the kernel-layer GROUNDED_SAFE_FALLBACK is a separate, earlier seam.
const WA_EMPTY_COMPLETION_HOLDING = process.env.WA_EMPTY_COMPLETION_HOLDING === "true";
const WA_HOLDING_MESSAGE_PTBR =
  "Desculpe, não consegui montar uma resposta agora. Pode tentar de novo? Se preferir, responda *menu* para ver as opções ou *ajuda* para falar com a gente.";

// ── Session shape resolved by resolveWhatsAppSession (shared by the helpers below) ──
type WaSession = Awaited<ReturnType<typeof resolveWhatsAppSession>>;

/** Send a WhatsApp message, swallowing failures (Twilio may be down). Best-effort only. */
async function sendBestEffort(to: string, message: string): Promise<void> {
  try {
    // Best-effort fallback/holding messages → branded via the fallback minter.
    await sendText(to, mintFallbackReply(message));
  } catch {
    // Best-effort — can't do more (e.g. Twilio is down)
  }
}

/** Track daily conversation count (new sessions) + per-session message count (SEC-003: atomic INCR + EXPIRE). */
async function trackMessageMetrics(session: WaSession, log: LogFn): Promise<void> {
  if (session.isNew) {
    try {
      const metricsRedis = await getRedisClient();
      const todayDateStr = new Date().toISOString().slice(0, 10);
      const convKey = rk(`metrics:conversations:daily:${todayDateStr}`);
      await atomicIncr(metricsRedis, convKey, 48 * 60 * 60);
    } catch (metricsErr) {
      log.warn({ error: String(metricsErr) }, "[whatsapp.metrics] Failed to track conversation count");
    }
  }

  try {
    const metricsRedis = await getRedisClient();
    const msgCountKey = rk(`metrics:messages:${session.sessionId}`);
    await atomicIncr(metricsRedis, msgCountKey, 48 * 60 * 60);
  } catch (metricsErr) {
    log.warn({ error: String(metricsErr) }, "[whatsapp.metrics] Failed to track message count");
  }
}

/** Store a GPS pin if the inbound carried one; synthesize a location message when the body is empty. */
async function storeLocationIfPresent(
  body: TwilioWebhookBody,
  messageBody: string,
  hash: string,
  session: WaSession,
  log: LogFn,
): Promise<void> {
  const lat = body.Latitude ? Number.parseFloat(body.Latitude) : undefined;
  const lng = body.Longitude ? Number.parseFloat(body.Longitude) : undefined;
  if (lat === undefined || lng === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
    return;
  }
  await storeLastLocation(hash, lat, lng);
  log.info({ phone_hash: hash }, "[whatsapp.location] GPS pin stored");
  // If message body is empty, synthesize a location message for the agent
  if (!messageBody) {
    const locationText = `[localização compartilhada: lat=${lat}, lng=${lng}]`;
    await appendMessages(session.sessionId, [{ role: "user", content: locationText }], true, {
      customerId: session.customerId,
      channel: "whatsapp",
    });
  }
}

/**
 * Fold the stored GPS pin + the "lgpd just sent" hint into the turn's inbound text.
 * Pre-cutover these reached the agent via `AgentContext`; the Capsule carries
 * neither, so they ride in the inbound text (the same channel the empty-body
 * location message already uses). Preserves the GPS-aware + LGPD-aware behavior.
 */
function buildAgentInput(
  baseInput: string,
  lastLocation: Awaited<ReturnType<typeof getLastLocation>>,
  lgpdJustSent: boolean,
): string {
  const inputSuffixes: string[] = [];
  if (lastLocation) {
    inputSuffixes.push(
      `[localização do cliente: lat=${lastLocation.lat}, lng=${lastLocation.lng}]`,
    );
  }
  if (lgpdJustSent) {
    inputSuffixes.push("[hint: lgpd_just_sent]");
  }
  return inputSuffixes.length > 0 ? `${baseInput}\n${inputSuffixes.join("\n")}` : baseInput;
}

/** PIX follow-up: send copia-e-cola + QR code if the LLM omitted them, then schedule expiry reminders. */
async function sendPixFollowUp(
  pixData: NonNullable<WhatsAppTurn["pixData"]>,
  agentText: string,
  phone: string,
  hash: string,
  session: WaSession,
  log: LogFn,
): Promise<void> {
  const { pixCopyPaste, pixQrCode } = pixData;
  const textHasPixCode = pixCopyPaste && agentText.includes(pixCopyPaste);

  if (pixCopyPaste && !textHasPixCode) {
    await sendText(
      `whatsapp:${phone}`,
      mintReceiptReply(
        `*Código PIX (copia e cola):*\n\n${pixCopyPaste}\n\n☝️ Copie e cole no app do seu banco.\nNÃO clique — cole no app.`,
      ),
    );
  }

  if (pixQrCode) {
    // EGRESS BRAND (Plan 1 / F4): mint the customer-facing caption at the
    // producer; sendMedia no longer mints prose internally.
    await sendMedia(`whatsapp:${phone}`, pixQrCode, mintReceiptReply("QR Code PIX")).catch((err) => {
      log.warn({ error: String(err) }, "[whatsapp.pix.qr_send_failed] Falling back to text-only PIX");
    });
  }

  // Schedule PIX expiry reminders (25min reminder + 30min expired)
  const pixOrderId = pixData.orderId;
  if (pixCopyPaste && (pixOrderId || session.customerId)) {
    void schedulePixExpiryMonitor({
      phone,
      phoneHash: hash,
      orderId: pixOrderId || session.customerId!,
    }).catch((err) => {
      log.warn({ error: String(err) }, "[whatsapp.pix.expiry_schedule_failed]");
    });
  }
}

type AgentTurnOutcome =
  | { handled: true }
  | { handled: false; response: WhatsAppTurn };

/**
 * Try the shortcut/state machine, then run the conductor turn raced against the
 * max-turn deadline (P2-CONC-ABORT). Returns `{ handled: true }` when a shortcut
 * already replied, otherwise the agent response.
 */
async function runConductorAgentTurn(args: {
  body: TwilioWebhookBody;
  messageBody: string;
  hash: string;
  phone: string;
  session: WaSession;
  userMessage: string;
  lgpdJustSent: boolean;
  turnAbort: AbortController;
  startMs: number;
  log: LogFn;
}): Promise<AgentTurnOutcome> {
  const { body, messageBody, hash, phone, session, userMessage, lgpdJustSent, turnAbort, startMs, log } = args;

  // ── Shortcut / state machine (bypass LLM if possible) ─────────────────
  const handled = await tryShortcutOrStateMachine(body, messageBody, hash, phone, session, log);
  if (handled) return { handled: true };

  // Load session history AFTER debounce to include all queued messages
  const history = await loadSession(session.sessionId);
  const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

  // Get the last user message from history (may differ from userMessage if multiple arrived)
  const lastUserMsg = [...trimmedHistory].reverse().find((m) => m.role === "user");
  const baseInput = lastUserMsg?.content || userMessage;

  const lastLocation = await getLastLocation(hash);
  const agentInput = buildAgentInput(baseInput, lastLocation, lgpdJustSent);

  log.info(
    { phone_hash: hash, session_id: session.sessionId, history_length: trimmedHistory.length },
    "[whatsapp.agent.start]",
  );

  // ── Run the conductor turn ────────────────────────────────────────────
  // The conductor loads memory + resolves tenant/policy from the Capsule. A
  // guest session (no real customer id) gets a guest marker.
  const conductorCustomerId = isGuestCustomerId(session.customerId)
    ? `guest:${session.sessionId}`
    : session.customerId;
  // Race the turn against the max-turn deadline (P2-CONC-ABORT). The Capsule takes
  // no external signal, so the race + the aborted-gate on the send is the bound.
  const turnPromise = runConductorTurn({
    input: agentInput,
    customerId: conductorCustomerId,
    sessionKey: session.sessionId,
    log,
  });
  turnPromise.catch(() => {}); // swallow a late rejection if the timeout wins
  const agentResponse = await Promise.race([
    turnPromise,
    new Promise<never>((_, reject) => {
      if (turnAbort.signal.aborted) reject(new Error("WhatsApp turn timed out"));
      turnAbort.signal.addEventListener("abort", () => reject(new Error("WhatsApp turn timed out")), { once: true });
    }),
  ]);

  const durationMs = Date.now() - startMs;
  log.info(
    {
      phone_hash: hash,
      duration_ms: durationMs,
      has_pix: Boolean(agentResponse.pixData),
    },
    "[whatsapp.agent.finish]",
  );

  return { handled: false, response: agentResponse };
}

/** Best-effort post-lock re-check; never let it crash the outer handler. */
async function safeRetryForMissedMessages(
  session: { sessionId: string; customerId: string },
  hash: string,
  phone: string,
  log: LogFn,
): Promise<void> {
  try {
    await retryForMissedMessages(session, hash, phone, log);
  } catch {
    // Best-effort re-check — don't let this crash the outer handler
  }
}

/** Phase 3 finalize: promote the claim on success / release it on failure (P2-SEC-WAIDEMPOTENCY). */
async function finalizeIdempotency(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  messageSid: string,
  succeeded: boolean,
  log: LogFn,
): Promise<void> {
  try {
    if (succeeded) {
      await confirmProcessed(redis, messageSid);
    } else {
      await releaseClaim(redis, messageSid);
    }
  } catch (finalizeErr) {
    log.warn(finalizeErr, "[whatsapp.async] Idempotency finalize failed (in-flight TTL is the backstop)");
  }
}

async function handleMessageAsync(
  body: TwilioWebhookBody,
  messageSid: string,
  phone: string,
  hash: string,
  messageBody: string,
  numMedia: number,
  log: LogFn,
): Promise<void> {
  // Phase 3 (P2-SEC-WAIDEMPOTENCY) + max-turn deadline (P2-CONC-ABORT).
  const idempotencyRedis = await getRedisClient();
  const turnAbort = new AbortController();
  const turnTimer = setTimeout(() => turnAbort.abort(), WA_TURN_TIMEOUT_MS);
  let succeeded = false;
  // Outer try/catch: early-stage crashes still send a fallback error message to the user
  try {
  const startMs = Date.now();

  // ── Cancel any pending hesitation nudge on incoming message ────────────────
  await markCustomerReplied(hash);

  // ── Media handling ──────────────────────────────────────────────────────────
  if (numMedia > 0 && !messageBody) {
    await sendText(
      `whatsapp:${phone}`,
      mintFallbackReply(
        "Recebi sua mídia 👍\n\nAinda não consigo analisar imagens ou áudio.\nPode me explicar em palavras?",
      ),
    );
    return;
  }

  // ── Resolve session ─────────────────────────────────────────────────────────
  const session = await resolveWhatsAppSession(phone);

  // ── Track conversation + per-session message counts (SEC-003: atomic INCR + EXPIRE) ──
  await trackMessageMetrics(session, log);

  // ── Store GPS location if provided ─────────────────────────────────────────
  await storeLocationIfPresent(body, messageBody, hash, session, log);
  log.info(
    { phone_hash: hash, session_id: session.sessionId, is_new: session.isNew },
    "[whatsapp.session.resolved]",
  );

  // Refresh TTL
  await touchSession(hash);

  // ── Welcome credit for new customers ────────────────────────────────────────
  // Set unconditionally — the bot promises R$15 in first_contact prompt, so the
  // credit must exist in Redis before checkout. getAndConsumeWelcomeCredit() is
  // idempotent (getDel), so no risk of double-apply.
  if (session.isNew) {
    await setWelcomeCredit(session.customerId);
    log.info({ customer_id: session.customerId }, "[whatsapp] Welcome credit set for new customer");

    // Schedule hesitation nudge — will fire in ~45s if customer hasn't replied
    await scheduleHesitationNudge({ phone, phoneHash: hash, customerId: session.customerId });
  }

  // ── LGPD opt-in disclosure (once per phone) ─────────────────────────────────
  const lgpdJustSent = !(await hasOptedIn(hash));
  if (lgpdJustSent) {
    await sendText(`whatsapp:${phone}`, mintFallbackReply(LGPD_OPTIN_MESSAGE));
    await markOptedIn(hash);
  }

  // ── Build user message (handle interactive selections) ──────────────────────
  // For location-only messages, the synthesized location text was already appended above.
  const userMessage = buildUserMessage(body, messageBody);
  if (userMessage) {
    await appendMessages(session.sessionId, [{ role: "user", content: userMessage }], true, {
      customerId: session.customerId,
      channel: "whatsapp",
    });
  }

  // ── Debounce (batch rapid-fire messages) ────────────────────────────────────
  // The 2s debounce window: first message sets an NX key (2s TTL) and becomes the
  // "runner." Subsequent messages within 2s return early (already in session history).
  // Edge case: a message at the 2s boundary starts a new runner; both compete for the
  // agent lock (keyed by phoneHash). The loser's messages are picked up by the
  // post-lock re-check mechanism, so no messages are permanently lost.
  const shouldRun = await tryDebounce(hash);
  if (!shouldRun) {
    // Another invocation will handle this — message is already in session history
    return;
  }

  // Wait for burst messages to accumulate
  await sleep(DEBOUNCE_MS);

  // ── Agent lock (keyed by phoneHash to handle session rotation) ─────────────
  const lockValue = await acquireAgentLock(hash);
  if (!lockValue) {
    // Another agent run is in progress — our message is in the session history
    return;
  }

  // `sendEntered` is flipped true immediately BEFORE `sendText` (never by
  // wrapping+swallowing it — that breaks Twilio retry/idempotency). The `:899`
  // catch reads it to discriminate a thrown send (`send_failed`) from a pre-send
  // turn exception (`turn_error`).
  let sendEntered = false;
  // `sendCompleted` is flipped true immediately AFTER `sendText` returns. The
  // catch reads BOTH flags so a POST-send throw (e.g. a later `appendMessages`
  // failure) is classified `turn_error`, not a spurious `send_failed` incident +
  // duplicate "problema técnico" message to an already-served customer (F2).
  let sendCompleted = false;
  try {
    // ── Shortcut / state machine + conductor turn (raced against the deadline) ──
    const outcome = await runConductorAgentTurn({
      body,
      messageBody,
      hash,
      phone,
      session,
      userMessage,
      lgpdJustSent,
      turnAbort,
      startMs,
      log,
    });
    if (outcome.handled) return;
    const agentResponse = outcome.response;

    // ── Send response ─────────────────────────────────────────────────────
    // Skip a stale reply if the turn raced past the deadline (P2-CONC-ABORT).
    // Gate on a TRIMMED non-blank reply (mirrors the retry M3 gate + classifyTurnDelivery):
    // a whitespace-only completion is NOT a delivered reply — sending it would push a
    // blank bubble AND make `deliveredText` (below) true, wrongly auto-resolving an
    // incident and masking the whitespace_only PIX-only guard (F5). Left unsent, so
    // `deliveredText == hasPixData` for a whitespace turn, exactly like empty_completion.
    let textSent = false;
    if (agentResponse.text && agentResponse.text.trim().length > 0 && !turnAbort.signal.aborted) {
      sendEntered = true;
      await sendText(`whatsapp:${phone}`, wrapLegacyResponderText(agentResponse.text));
      sendCompleted = true;
      textSent = true;

      // Save assistant response to session
      await appendMessages(session.sessionId, [
        { role: "assistant", content: agentResponse.text },
      ], true, { customerId: session.customerId, channel: "whatsapp" });
    }
    // The message was processed (text delivered, or intentionally empty). PIX
    // follow-up below is supplementary/best-effort — a QR failure must NOT cause
    // Twilio to reprocess the whole turn, so mark success here (P2-SEC-WAIDEMPOTENCY).
    succeeded = true;

    // ── PIX follow-up: send copia-e-cola + QR code if LLM omitted them ──
    if (agentResponse.pixData) {
      await sendPixFollowUp(agentResponse.pixData, agentResponse.text, phone, hash, session, log);
    }

    // ── No-delivery reconcile (AFTER the PIX block — false-positive fix) ──
    // PIX copia-e-cola + QR is delivered regardless of text, so a turn with
    // empty text but `pixData` DID reach the customer. `deliveredText` keys the
    // genuine-drop decision on what actually reached the customer.
    const hasPixData = Boolean(agentResponse.pixData);
    const deliveredText = textSent || hasPixData;

    // ── Auto-close (Q2): a successfully-delivered reply self-heals an OPEN
    // incident on this session → AUTO_RESOLVED. Gated on the SAME delivered
    // predicate as detection (REVIEW-v2: a PIX-only recovery must close too, so
    // this sits OUT of the `if (agentResponse.text…)` text gate). Fail-open,
    // idempotent, fast-null on the happy path. ──
    if (deliveredText && agentResponse.turnId) {
      // Detached (L10): the close is fail-open + idempotent, so it must NOT be
      // awaited on the hot path — awaiting a DB lookup on every delivered reply
      // extends the lock-hold and gates finally/lock-release/finalizeIdempotency.
      // Fire-and-forget with a swallow (behavior otherwise identical).
      void closeIncidentOnDeliveredReply(session.sessionId, agentResponse.turnId, log).catch(
        () => {},
      );
    }

    const classification = classifyTurnDelivery({
      disposition: agentResponse.disposition,
      ...(agentResponse.decisionKind !== undefined ? { decisionKind: agentResponse.decisionKind } : {}),
      deliveredText,
    });
    if (classification) {
      // Ordered classify → emit → open → (holding). Emission can never be masked
      // by a substitution bug because the holding send is strictly last.
      const signal = {
        sessionId: session.sessionId,
        cause: classification.cause,
        customerImpacted: classification.customerImpacted,
        channel: "whatsapp",
        customerId: session.customerId,
        senderRef: `whatsapp:${phone}`,
        phoneHash: hash,
        turnId: agentResponse.turnId ?? null,
        decisionKind: agentResponse.decisionKind ?? null,
      };
      await emitNoDelivery(signal, log);
      await openIncidentInline(signal, log);

      // Customer-facing holding message — ONLY for an empty/whitespace
      // completion (NOT the abort-with-text timeout path, NOT the pause).
      if (
        WA_EMPTY_COMPLETION_HOLDING &&
        (agentResponse.disposition === "empty_completion" ||
          agentResponse.disposition === "whitespace_only")
      ) {
        await sendBestEffort(`whatsapp:${phone}`, WA_HOLDING_MESSAGE_PTBR);
      }
    }

  } catch (err) {
    log.error(err, "[whatsapp.agent.error] Agent processing failed");
    // Discriminate the throw into a cause (no `turnId` is in scope here — the
    // capsule opened+closed inside `runConductorTurn`; dedup on `MessageSid`).
    const cause = classifyCatchError({
      aborted: turnAbort.signal.aborted,
      message: (err as Error).message,
      sendEntered,
      sendCompleted,
    });
    // `turn_error` is OUT of the frozen taxonomy → canned apology only, no
    // incident. `timeout` / `send_failed` open a governed incident.
    if (cause === "timeout" || cause === "send_failed") {
      const signal = {
        sessionId: session.sessionId,
        cause,
        customerImpacted: true,
        channel: "whatsapp",
        customerId: session.customerId,
        senderRef: `whatsapp:${phone}`,
        phoneHash: hash,
        turnId: null,
        messageSid: body.MessageSid ?? null,
      };
      await emitNoDelivery(signal, log);
      await openIncidentInline(signal, log);
    }
    // Send fallback error message (best-effort) — unchanged behavior.
    await sendBestEffort(
      `whatsapp:${phone}`,
      "Desculpe, estou com um problema técnico. Tente novamente em alguns instantes.",
    );
  } finally {
    await releaseAgentLock(hash, lockValue);
    // Re-check for unprocessed messages after lock release (best-effort)
    await safeRetryForMissedMessages(session, hash, phone, log);
  }
  } catch (outerErr) {
    log.error(outerErr, "[whatsapp.handler.error] Early-stage failure in async handler");
    await sendBestEffort(
      `whatsapp:${phone}`,
      "Desculpe, ocorreu um erro. Tente novamente em alguns instantes.",
    );
  } finally {
    clearTimeout(turnTimer);
    // Phase 3 (P2-SEC-WAIDEMPOTENCY): promote the claim on success so the SID is
    // dedup'd for the full window; on failure release it so Twilio's retry can
    // reprocess instead of being black-holed for 24h. The short in-flight TTL is
    // the backstop.
    await finalizeIdempotency(idempotencyRedis, messageSid, succeeded, log);
  }
}
