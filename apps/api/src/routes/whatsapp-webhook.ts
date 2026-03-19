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
import { getRedisClient, rk } from "@ibatexas/tools";
// AUDIT-FIX: EVT-F04 — Removed unused publishNatsEvent import (dead whatsapp events removed)
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
} from "../whatsapp/session.js";
import { collectAgentResponse } from "../whatsapp/formatter.js";
import { sendText } from "../whatsapp/client.js";
import { matchShortcut, buildHelpText } from "../whatsapp/shortcuts.js";
import { handleStateMachine, transitionTo } from "../whatsapp/state-machine.js";

const MAX_RATE_PER_MINUTE = 20;
const DEBOUNCE_MS = 2000;
const MAX_HISTORY_MESSAGES = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// AUDIT-FIX: REDIS-M03 — EXPIRE unconditionally on every INCR to prevent immortal keys after crash
async function checkWebhookRateLimit(redis: Awaited<ReturnType<typeof getRedisClient>>, hash: string): Promise<boolean> {
  const rateKey = rk(`wa:rate:${hash}`);
  const rateCount = await redis.incr(rateKey);
  await redis.expire(rateKey, 60); // idempotent TTL reset
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
  // AUDIT-FIX: WA-M06 — Scope form-urlencoded content type parser to the webhook route
  // only via Fastify's encapsulated plugin registration. This prevents replacing Fastify's
  // default form parser on all other routes.
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

async function handleMessageAsync(
  body: TwilioWebhookBody,
  phone: string,
  hash: string,
  messageBody: string,
  numMedia: number,
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<void> {
  // AUDIT-FIX: WA-M03 — Outer try/catch wraps entire function body so that early-stage
  // crashes (Redis/Prisma down during session resolution, debounce, etc.) still send
  // a fallback error message to the user instead of failing silently.
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

  // ── Build user message (handle interactive selections) ──────────────────────
  const userMessage = buildUserMessage(body, messageBody);

  // Append user message to session
  await appendMessages(session.sessionId, [{ role: "user", content: userMessage }], true);

  // AUDIT-FIX: EVT-F04 — Removed dead whatsapp.message.received NATS event (no subscriber existed)

  // ── Debounce (batch rapid-fire messages) ────────────────────────────────────
  // AUDIT-FIX: WA-L09 — Debounce boundary edge case documentation:
  // The 2s debounce window works as follows: the first message sets an NX key (2s TTL)
  // and becomes the "runner." Subsequent messages within 2s return early (their content
  // is already in session history). The runner then sleeps 2s to let burst messages
  // accumulate before loading history. Edge case: a message arriving exactly at the 2s
  // boundary (after the NX key expires but before the runner loads history) starts a
  // NEW debounce window and a new runner. Both runners then compete for the agent lock
  // (keyed by phoneHash). The loser's messages go unprocessed until the post-lock
  // re-check (AUDIT-FIX WA-H02) picks them up. This is acceptable behavior — the
  // re-check mechanism ensures no messages are permanently lost.
  const shouldRun = await tryDebounce(hash);
  if (!shouldRun) {
    // Another invocation will handle this — message is already in session history
    return;
  }

  // Wait for burst messages to accumulate
  await sleep(DEBOUNCE_MS);

  // ── Agent lock ──────────────────────────────────────────────────────────────
  // AUDIT-FIX: REDIS-H03/WA-H01 — lock keyed by phoneHash (not sessionId)
  const lockAcquired = await acquireAgentLock(hash);
  if (!lockAcquired) {
    // Another agent run is in progress — our message is in the session history
    return;
  }

  try {
    // ── Shortcut check (bypass LLM entirely) ────────────────────────────────
    const interactiveId = body.ListId || body.ButtonPayload || undefined;
    const shortcut = matchShortcut(messageBody);

    if (shortcut) {
      log.info({ phone_hash: hash, shortcut: shortcut.type }, "[whatsapp.shortcut]");

      const response = await handleShortcut(shortcut.type, hash);
      if (response) {
        await sendText(`whatsapp:${phone}`, response);
        await appendMessages(session.sessionId, [{ role: "assistant", content: response }]);
        return;
      }
    }

    // ── State machine check (deterministic flows) ───────────────────────────
    const stateAction = await handleStateMachine(hash, messageBody, interactiveId);
    if (stateAction) {
      log.info(
        { phone_hash: hash, action: stateAction.action, next_state: stateAction.nextState },
        "[whatsapp.state_machine]",
      );
      await transitionTo(hash, stateAction.nextState);
      // State machine returns an action to execute — delegate to agent with explicit instruction
      const paramsSuffix = stateAction.params ? `, params=${JSON.stringify(stateAction.params)}` : "";
      const stateMessage = `[state_action: ${stateAction.action}${paramsSuffix}]`;
      // Append the state action as context for the agent
      await appendMessages(session.sessionId, [{ role: "user", content: stateMessage }], true);
    }

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

    // AUDIT-FIX: EVT-F04 — Removed dead whatsapp.message.sent NATS event (no subscriber existed)
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
    // AUDIT-FIX: REDIS-H03/WA-H01 — release lock by phoneHash (not sessionId)
    await releaseAgentLock(hash);

    // AUDIT-FIX: WA-H02 — re-check for unprocessed messages after lock release.
    // If new user messages arrived while the agent was running, they were appended
    // to session history but the running agent never saw them. Re-acquire lock and
    // re-run agent once (max retry = 1 to prevent loops).
    try {
      const postHistory = await loadSession(session.sessionId);
      const lastMsg = postHistory.length > 0 ? postHistory[postHistory.length - 1] : null;
      if (lastMsg && lastMsg.role === "user") {
        // A user message arrived after the agent's last response — re-process
        const retryLock = await acquireAgentLock(hash);
        if (retryLock) {
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
      }
    } catch {
      // Best-effort re-check — don't let this crash the outer handler
    }
  }
  // AUDIT-FIX: WA-M03 — Outer catch for early-stage failures (before agent lock try/catch)
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
