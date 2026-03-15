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

import type { FastifyInstance } from "fastify";
import { parse as parseQuerystring } from "node:querystring";
import twilio from "twilio";
import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
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

export async function whatsappWebhookRoutes(server: FastifyInstance): Promise<void> {
  // Register custom content type parser for form-urlencoded (Twilio sends this)
  server.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer", bodyLimit: 1_048_576 },
    (req, body, done) => {
      if (req.url === "/api/webhooks/whatsapp") {
        try {
          const parsed = parseQuerystring((body as Buffer).toString("utf-8"));
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      } else {
        // Let other routes handle normally
        try {
          done(null, parseQuerystring((body as Buffer).toString("utf-8")));
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    },
  );

  server.post(
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
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const webhookUrl = process.env.TWILIO_WEBHOOK_URL;

      if (!authToken || !webhookUrl) {
        server.log.error("[whatsapp.config] TWILIO_AUTH_TOKEN or TWILIO_WEBHOOK_URL not set");
        return reply.code(500).send({ error: "Webhook not configured" });
      }

      const signature = request.headers["x-twilio-signature"];
      if (typeof signature !== "string") {
        server.log.warn({ ip: request.ip }, "[whatsapp.incoming] Missing X-Twilio-Signature");
        return reply.code(400).send({ error: "Missing signature" });
      }

      const isValid = twilio.validateRequest(
        authToken,
        signature,
        webhookUrl,
        body as Record<string, string>,
      );

      if (!isValid) {
        server.log.warn({ ip: request.ip }, "[whatsapp.incoming] Invalid Twilio signature");
        return reply.code(403).send({ error: "Invalid signature" });
      }

      // ── 2. Guard empty messages ─────────────────────────────────────────────
      const messageBody = body.Body?.trim() || "";
      const numMedia = parseInt(body.NumMedia || "0", 10);

      if (!messageBody && numMedia === 0) {
        return reply.code(200).type("text/xml").send("<Response/>");
      }

      // ── 3. Extract and validate fields ──────────────────────────────────────
      const messageSid = body.MessageSid;
      const fromRaw = body.From;

      if (!messageSid || !fromRaw) {
        server.log.warn("[whatsapp.incoming] Missing MessageSid or From");
        return reply.code(400).send({ error: "Missing required fields" });
      }

      let phone: string;
      let hash: string;
      try {
        phone = normalizePhone(fromRaw);
        hash = hashPhone(phone);
      } catch {
        server.log.warn({ from: fromRaw }, "[whatsapp.incoming] Invalid phone format");
        return reply.code(400).send({ error: "Invalid phone format" });
      }

      server.log.info(
        { phone_hash: hash, message_sid: messageSid, processing_ms: Date.now() - startMs },
        "[whatsapp.incoming] Message received",
      );

      // ── 4. Idempotency (BEFORE rate limit) ─────────────────────────────────
      const redis = await getRedisClient();
      const idempotencyKey = rk(`wa:webhook:${messageSid}`);
      const wasSet = await redis.set(idempotencyKey, "1", { EX: 86400, NX: true });
      if (!wasSet) {
        server.log.info({ message_sid: messageSid }, "[whatsapp.duplicate] Already processed");
        return reply.code(200).type("text/xml").send("<Response/>");
      }

      // ── 5. Rate limit ──────────────────────────────────────────────────────
      const rateKey = rk(`wa:rate:${hash}`);
      const rateCount = await redis.incr(rateKey);
      if (rateCount === 1) {
        await redis.expire(rateKey, 60);
      }
      if (rateCount > MAX_RATE_PER_MINUTE) {
        server.log.warn({ phone_hash: hash, rate: rateCount }, "[whatsapp.rate] Rate limit exceeded");
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
}

async function handleMessageAsync(
  body: TwilioWebhookBody,
  phone: string,
  hash: string,
  messageBody: string,
  numMedia: number,
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<void> {
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
  let userMessage = messageBody;

  if (body.ListId || body.ButtonPayload) {
    const selectionType = body.ListId ? "list" : "button";
    const selectionId = body.ListId || body.ButtonPayload;
    const selectionTitle = body.ListTitle || body.ButtonText || "";
    userMessage = `Usuário selecionou: ${selectionTitle}\n[interactive_selection: type=${selectionType}, id=${selectionId}]`;
  }

  // Append user message to session
  await appendMessages(session.sessionId, [{ role: "user", content: userMessage }], true);

  // Publish received event
  void publishNatsEvent("ibatexas.whatsapp.message.received", {
    eventType: "whatsapp.message.received",
    phone_hash: hash,
    sessionId: session.sessionId,
    customerId: session.customerId,
    hasMedia: numMedia > 0,
  }).catch(() => {}); // fire-and-forget

  // ── Debounce (batch rapid-fire messages) ────────────────────────────────────
  const shouldRun = await tryDebounce(hash);
  if (!shouldRun) {
    // Another invocation will handle this — message is already in session history
    return;
  }

  // Wait for burst messages to accumulate
  await sleep(DEBOUNCE_MS);

  // ── Agent lock ──────────────────────────────────────────────────────────────
  const lockAcquired = await acquireAgentLock(session.sessionId);
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

      let response: string | null = null;
      switch (shortcut.type) {
        case "help":
          response = buildHelpText();
          break;
        case "menu":
          await transitionTo(hash, "browsing");
          // Fall through to agent for product search (agent calls search_products)
          break;
        case "cart":
          // Fall through to agent for cart display (agent calls get_cart)
          break;
        case "reservation":
          await transitionTo(hash, "reservation_flow");
          // Fall through to agent for reservation flow
          break;
      }

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
      const stateMessage = `[state_action: ${stateAction.action}${stateAction.params ? `, params=${JSON.stringify(stateAction.params)}` : ""}]`;
      // Append the state action as context for the agent
      await appendMessages(session.sessionId, [{ role: "user", content: stateMessage }], true);
    }

    // ── Agent call ──────────────────────────────────────────────────────────
    // Load session history AFTER debounce to include all queued messages
    const history = await loadSession(session.sessionId);
    const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

    // Get the last user message from history (may differ from userMessage if multiple arrived)
    const lastUserMsg = trimmedHistory.filter((m) => m.role === "user").pop();
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

    // Publish sent event
    void publishNatsEvent("ibatexas.whatsapp.message.sent", {
      eventType: "whatsapp.message.sent",
      phone_hash: hash,
      sessionId: session.sessionId,
      customerId: session.customerId,
      tools_used: agentResponse.toolsUsed,
      duration_ms: durationMs,
    }).catch(() => {}); // fire-and-forget
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
    await releaseAgentLock(session.sessionId);
  }
}
