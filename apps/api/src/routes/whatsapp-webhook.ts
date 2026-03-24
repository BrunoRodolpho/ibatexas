// WhatsApp webhook handler — Twilio incoming message webhook.
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

import type { FastifyInstance, FastifyRequest } from "fastify";
import { parse as parseQuerystring } from "node:querystring";
import twilio from "twilio";
import { getRedisClient, rk, atomicIncr } from "@ibatexas/tools";
import { runAgent } from "@ibatexas/llm-provider";
import { loadSession, appendMessages } from "../session/store.js";
import {
  normalizePhone,
  hashPhone,
  resolveWhatsAppSession,
  buildWhatsAppContext,
  touchSession,
  acquireAgentLock,
  releaseAgentLock,
  tryDebounce,
  hasOptedIn,
  markOptedIn,
} from "../whatsapp/session.js";
import { collectAgentResponse } from "../whatsapp/formatter.js";
import { sendText } from "../whatsapp/client.js";
import { matchShortcut, buildHelpText } from "../whatsapp/shortcuts.js";
import { handleStateMachine, transitionTo } from "../whatsapp/state-machine.js";
import { LGPD_OPTIN_MESSAGE } from "../whatsapp/constants.js";

const MAX_RATE_PER_MINUTE = 20;
const DEBOUNCE_MS = 2000;
const MAX_HISTORY_MESSAGES = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type LogFn = { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

/**
 * Post-lock re-check: if new user messages arrived while the agent was running,
 * re-acquire lock and re-run agent once (max retry = 1 to prevent loops).
 */
async function retryForMissedMessages(
  session: Parameters<typeof buildWhatsAppContext>[0],
  hash: string,
  phone: string,
  log: LogFn,
): Promise<void> {
  const postHistory = await loadSession(session.sessionId);
  const lastMsg = postHistory.at(-1);
  if (lastMsg?.role !== "user") return;

  const retryLock = await acquireAgentLock(hash);
  if (!retryLock) return;

  try {
    const retryHistory = await loadSession(session.sessionId);
    const retryTrimmed = retryHistory.slice(-MAX_HISTORY_MESSAGES);
    const retryLastUser = [...retryTrimmed].reverse().find((m) => m.role === "user");
    const retryInput = retryLastUser?.content || "";
    const retryContext = buildWhatsAppContext(session);

    log.info({ phone_hash: hash }, "[whatsapp.agent.retry] Re-running agent for missed messages");
    const retryResponse = await collectAgentResponse(
      runAgent(retryInput, retryTrimmed, retryContext),
    );

    if (retryResponse.text) {
      await sendText(`whatsapp:${phone}`, retryResponse.text);
      await appendMessages(session.sessionId, [
        { role: "assistant", content: retryResponse.text },
      ]);
    }
  } catch (retryErr) {
    log.error(retryErr, "[whatsapp.agent.retry.error] Retry agent processing failed");
  } finally {
    await releaseAgentLock(hash);
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

async function checkIdempotency(redis: Awaited<ReturnType<typeof getRedisClient>>, messageSid: string): Promise<boolean> {
  const idempotencyKey = rk(`wa:webhook:${messageSid}`);
  const wasSet = await redis.set(idempotencyKey, "1", { EX: 86400, NX: true });
  return !wasSet;
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
  hash: string,
): Promise<string | null> {
  switch (shortcutType) {
    case "help":
      return buildHelpText();
    case "menu":
      await transitionTo(hash, "browsing");
      return null; // Fall through to agent
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

      if (!messageBody && numMedia === 0) {
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

      // ── 4. Idempotency (BEFORE rate limit) ─────────────────────────────────
      const redis = await getRedisClient();
      const isDuplicate = await checkIdempotency(redis, messageSid);
      if (isDuplicate) {
        server.log.info({ message_sid: messageSid }, "[whatsapp.duplicate] Already processed");
        return reply.code(200).type("text/xml").send("<Response/>");
      }

      // ── 5. Rate limit ──────────────────────────────────────────────────────
      const rateLimited = await checkWebhookRateLimit(redis, hash);
      if (rateLimited) {
        server.log.warn({ phone_hash: hash }, "[whatsapp.rate] Rate limit exceeded");
        return reply.code(429).type("text/xml").send("<Response/>");
      }

      // ── 6. Return 200 immediately ──────────────────────────────────────────
      void reply.code(200).type("text/xml").send("<Response/>");

      // ── 7. Async processing (decoupled from Fastify lifecycle) ─────────────
      void handleMessageAsync(body, phone, hash, messageBody, numMedia, server.log).catch((err) => {
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
  session: { sessionId: string },
  log: LogFn,
): Promise<boolean> {
  const shortcut = matchShortcut(messageBody);
  if (shortcut) {
    log.info({ phone_hash: hash, shortcut: shortcut.type }, "[whatsapp.shortcut]");
    const response = await handleShortcut(shortcut.type, hash);
    if (response) {
      await sendText(`whatsapp:${phone}`, response);
      await appendMessages(session.sessionId, [{ role: "assistant", content: response }]);
      return true;
    }
  }

  const interactiveId = body.ListId || body.ButtonPayload || undefined;
  const stateAction = await handleStateMachine(hash, messageBody, interactiveId);
  if (stateAction) {
    log.info(
      { phone_hash: hash, action: stateAction.action, next_state: stateAction.nextState },
      "[whatsapp.state_machine]",
    );
    await transitionTo(hash, stateAction.nextState);
    const paramsSuffix = stateAction.params ? `, params=${JSON.stringify(stateAction.params)}` : "";
    const stateMessage = `[state_action: ${stateAction.action}${paramsSuffix}]`;
    await appendMessages(session.sessionId, [{ role: "user", content: stateMessage }], true);
  }

  return false;
}

async function handleMessageAsync(
  body: TwilioWebhookBody,
  phone: string,
  hash: string,
  messageBody: string,
  numMedia: number,
  log: LogFn,
): Promise<void> {
  // Outer try/catch: early-stage crashes still send a fallback error message to the user
  try {
  const startMs = Date.now();

  // ── Media handling ──────────────────────────────────────────────────────────
  if (numMedia > 0 && !messageBody) {
    await sendText(
      `whatsapp:${phone}`,
      "Recebi sua mídia 👍\n\nAinda não consigo analisar imagens ou áudio.\nPode me explicar em palavras?",
    );
    return;
  }

  // ── Resolve session ─────────────────────────────────────────────────────────
  const session = await resolveWhatsAppSession(phone);
  log.info(
    { phone_hash: hash, session_id: session.sessionId, is_new: session.isNew },
    "[whatsapp.session.resolved]",
  );

  // Refresh TTL
  await touchSession(hash);

  // ── LGPD opt-in disclosure (once per phone) ─────────────────────────────────
  const optedIn = await hasOptedIn(hash);
  if (!optedIn) {
    await sendText(`whatsapp:${phone}`, LGPD_OPTIN_MESSAGE);
    await markOptedIn(hash);
  }

  // ── Build user message (handle interactive selections) ──────────────────────
  const userMessage = buildUserMessage(body, messageBody);

  // Append user message to session
  await appendMessages(session.sessionId, [{ role: "user", content: userMessage }], true);

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
  const lockAcquired = await acquireAgentLock(hash);
  if (!lockAcquired) {
    // Another agent run is in progress — our message is in the session history
    return;
  }

  try {
    // ── Shortcut / state machine (bypass LLM if possible) ─────────────────
    const handled = await tryShortcutOrStateMachine(body, messageBody, hash, phone, session, log);
    if (handled) return;

    // ── Agent call ──────────────────────────────────────────────────────────
    // Load session history AFTER debounce to include all queued messages
    const history = await loadSession(session.sessionId);
    const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

    // Get the last user message from history (may differ from userMessage if multiple arrived)
    const lastUserMsg = [...trimmedHistory].reverse().find((m) => m.role === "user");
    const agentInput = lastUserMsg?.content || userMessage;

    const context = buildWhatsAppContext(session);

    log.info(
      { phone_hash: hash, session_id: session.sessionId, history_length: trimmedHistory.length },
      "[whatsapp.agent.start]",
    );

    // ── Run agent ───────────────────────────────────────────────────────────
    const agentResponse = await collectAgentResponse(
      runAgent(agentInput, trimmedHistory, context),
    );

    const durationMs = Date.now() - startMs;
    log.info(
      {
        phone_hash: hash,
        duration_ms: durationMs,
        tools_used: agentResponse.toolsUsed,
        input_tokens: agentResponse.inputTokens,
        output_tokens: agentResponse.outputTokens,
      },
      "[whatsapp.agent.finish]",
    );

    // ── Send response ─────────────────────────────────────────────────────
    if (agentResponse.text) {
      await sendText(`whatsapp:${phone}`, agentResponse.text);

      // Save assistant response to session
      await appendMessages(session.sessionId, [
        { role: "assistant", content: agentResponse.text },
      ]);
    }

  } catch (err) {
    log.error(err, "[whatsapp.agent.error] Agent processing failed");

    // Send fallback error message
    try {
      await sendText(
        `whatsapp:${phone}`,
        "Desculpe, estou com um problema técnico. Tente novamente em alguns instantes.",
      );
    } catch {
      // Best-effort — can't do more
    }
  } finally {
    await releaseAgentLock(hash);

    // Re-check for unprocessed messages after lock release
    try {
      await retryForMissedMessages(session, hash, phone, log);
    } catch {
      // Best-effort re-check — don't let this crash the outer handler
    }
  }
  } catch (outerErr) {
    log.error(outerErr, "[whatsapp.handler.error] Early-stage failure in async handler");
    try {
      await sendText(
        `whatsapp:${phone}`,
        "Desculpe, ocorreu um erro. Tente novamente em alguns instantes.",
      );
    } catch {
      // Best-effort — sendText itself may fail if Twilio is down
    }
  }
}
