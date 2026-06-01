// WhatsApp flag-OFF legacy brain — the pre-cutover @ibatexas/llm-provider
// runOrchestrator conversational path, restored byte-for-byte from `main`.
//
// RC_A1_ACTIVATE unset (the shipping default) ⇒ the claustrum Conductor is never
// bootstrapped, so the cutover `handleInboundAsync` (getConductor()) would throw
// and the customer would receive NO reply (MERGE-READINESS Part C blocker).
// whatsapp-webhook.ts therefore dispatches here when `tryGetConductor() === null`,
// mirroring the customer-intent-gateway's `tryGetConductor()===null → legacy()`
// pattern, so WhatsApp keeps main's working brain with the flag OFF.
//
// The security envelope (Twilio signature, two-phase idempotency claim, per-phone
// rate limit) stays in whatsapp-webhook.ts; this module owns ONLY the async
// conversational turn, and promotes/releases the shared idempotency claim
// (whatsapp-idempotency.ts) on completion. This whole module is removed in the
// same atomic change as the production flag flip.

import { getRedisClient, rk, atomicIncr } from "@ibatexas/tools";
import { runOrchestrator } from "@ibatexas/llm-provider";
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
  setWelcomeCredit,
  storeLastLocation,
  getLastLocation,
} from "../whatsapp/session.js";
import { collectAgentResponse } from "../whatsapp/formatter.js";
import { sendText, sendMedia } from "../whatsapp/client.js";
import { matchShortcut, buildHelpText, buildWelcomeText } from "../whatsapp/shortcuts.js";
import { LGPD_OPTIN_MESSAGE } from "../whatsapp/constants.js";
import { scheduleHesitationNudge, markCustomerReplied } from "../jobs/hesitation-nudge.js";
import { schedulePixExpiryMonitor } from "../jobs/pix-expiry-monitor.js";
import { confirmProcessed, releaseClaim } from "./whatsapp-idempotency.js";

const DEBOUNCE_MS = 2000;
const MAX_HISTORY_MESSAGES = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type LogFn = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/** All Twilio webhook fields the legacy brain reads (all optional — querystring). */
interface WaBody {
  MessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  ProfileName?: string;
  ButtonText?: string;
  ButtonPayload?: string;
  ListId?: string;
  ListTitle?: string;
  Latitude?: string;
  Longitude?: string;
}

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

  const retryLockValue = await acquireAgentLock(hash);
  if (!retryLockValue) return;

  try {
    const retryHistory = await loadSession(session.sessionId);
    const retryTrimmed = retryHistory.slice(-MAX_HISTORY_MESSAGES);
    const retryLastUser = [...retryTrimmed].reverse().find((m) => m.role === "user");
    const retryInput = retryLastUser?.content || "";
    const retryLocation = await getLastLocation(hash);
    const retryContext = buildWhatsAppContext(session, retryLocation ?? undefined);

    log.info({ phone_hash: hash }, "[whatsapp.agent.retry] Re-running agent for missed messages");
    const retryResponse = await collectAgentResponse(
      runOrchestrator(retryInput, retryTrimmed, retryContext),
    );

    if (retryResponse.text) {
      await sendText(`whatsapp:${phone}`, retryResponse.text);
      await appendMessages(session.sessionId, [
        { role: "assistant", content: retryResponse.text },
      ], true, { customerId: session.customerId, channel: "whatsapp" });
    }
  } catch (retryErr) {
    log.error(retryErr, "[whatsapp.agent.retry.error] Retry agent processing failed");
  } finally {
    await releaseAgentLock(hash, retryLockValue);
  }
}

/** Try shortcut before resorting to the LLM agent. Returns true if handled. */
async function handleShortcut(shortcutType: string): Promise<string | null> {
  switch (shortcutType) {
    case "help":
      return buildHelpText();
    case "welcome":
      return buildWelcomeText();
    default:
      return null; // Fall through to agent (XState handles state)
  }
}

async function tryShortcutOrStateMachine(
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
      await sendText(`whatsapp:${phone}`, response);
      await appendMessages(session.sessionId, [{ role: "assistant", content: response }], true, {
        customerId: session.customerId,
        channel: "whatsapp",
      });
      return true;
    }
  }
  return false;
}

/** Build user message from interactive selections (list/button), else the body. */
function buildUserMessage(body: WaBody, messageBody: string): string {
  if (!body.ListId && !body.ButtonPayload) return messageBody;

  const selectionType = body.ListId ? "list" : "button";
  const selectionId = body.ListId || body.ButtonPayload;
  const selectionTitle = body.ListTitle || body.ButtonText || "";
  return `Usuário selecionou: ${selectionTitle}\n[interactive_selection: type=${selectionType}, id=${selectionId}]`;
}

/**
 * The pre-cutover conversational turn (main's handleMessageAsync), unchanged
 * except that phone/hash/messageBody/numMedia are recomputed here from `body`
 * (the route used to pass them in). Self-handles all errors (sends a fallback
 * message, never rethrows), so it returns normally on every real path.
 */
async function runLegacyTurn(body: WaBody, log: LogFn): Promise<void> {
  const fromRaw = body.From ?? "";
  const messageBody = (body.Body ?? "").trim();
  const numMedia = Number.parseInt(body.NumMedia ?? "0", 10);

  let phone: string;
  let hash: string;
  try {
    phone = normalizePhone(fromRaw);
    hash = hashPhone(phone);
  } catch {
    log.warn({ from: fromRaw }, "[whatsapp.legacy] Invalid phone format — dropping");
    return;
  }

  // Outer try/catch: early-stage crashes still send a fallback error message.
  try {
    const startMs = Date.now();

    await markCustomerReplied(hash);

    // ── Media handling ──────────────────────────────────────────────────────
    if (numMedia > 0 && !messageBody) {
      await sendText(
        `whatsapp:${phone}`,
        "Recebi sua mídia 👍\n\nAinda não consigo analisar imagens ou áudio.\nPode me explicar em palavras?",
      );
      return;
    }

    // ── Resolve session ───────────────────────────────────────────────────────
    const session = await resolveWhatsAppSession(phone);

    // ── Track daily conversation count (SEC-003: atomic INCR + EXPIRE) ────────
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

    // ── Track per-session message count (SEC-003: atomic INCR + EXPIRE) ───────
    try {
      const metricsRedis = await getRedisClient();
      const msgCountKey = rk(`metrics:messages:${session.sessionId}`);
      await atomicIncr(metricsRedis, msgCountKey, 48 * 60 * 60);
    } catch (metricsErr) {
      log.warn({ error: String(metricsErr) }, "[whatsapp.metrics] Failed to track message count");
    }

    // ── Store GPS location if provided ──────────────────────────────────────
    const lat = body.Latitude ? Number.parseFloat(body.Latitude) : undefined;
    const lng = body.Longitude ? Number.parseFloat(body.Longitude) : undefined;
    if (lat !== undefined && lng !== undefined && !Number.isNaN(lat) && !Number.isNaN(lng)) {
      await storeLastLocation(hash, lat, lng);
      log.info({ phone_hash: hash }, "[whatsapp.location] GPS pin stored");
      if (!messageBody) {
        const locationText = `[localização compartilhada: lat=${lat}, lng=${lng}]`;
        await appendMessages(session.sessionId, [{ role: "user", content: locationText }], true, {
          customerId: session.customerId,
          channel: "whatsapp",
        });
      }
    }
    log.info(
      { phone_hash: hash, session_id: session.sessionId, is_new: session.isNew },
      "[whatsapp.session.resolved]",
    );

    await touchSession(hash);

    // ── Welcome credit for new customers ────────────────────────────────────
    // Set unconditionally — the bot promises R$15 in the first_contact prompt, so
    // the credit must exist in Redis before checkout. getAndConsumeWelcomeCredit()
    // is idempotent (getDel), so no risk of double-apply.
    if (session.isNew) {
      await setWelcomeCredit(session.customerId);
      log.info({ customer_id: session.customerId }, "[whatsapp] Welcome credit set for new customer");
      await scheduleHesitationNudge({ phone, phoneHash: hash, customerId: session.customerId });
    }

    // ── LGPD opt-in disclosure (once per phone) ─────────────────────────────
    const lgpdJustSent = !(await hasOptedIn(hash));
    if (lgpdJustSent) {
      await sendText(`whatsapp:${phone}`, LGPD_OPTIN_MESSAGE);
      await markOptedIn(hash);
    }

    // ── Build user message (handle interactive selections) ──────────────────
    const userMessage = buildUserMessage(body, messageBody);
    if (userMessage) {
      await appendMessages(session.sessionId, [{ role: "user", content: userMessage }], true, {
        customerId: session.customerId,
        channel: "whatsapp",
      });
    }

    // ── Debounce (batch rapid-fire messages) ────────────────────────────────
    const shouldRun = await tryDebounce(hash);
    if (!shouldRun) return; // another invocation handles it — already in history

    await sleep(DEBOUNCE_MS);

    // ── Agent lock (keyed by phoneHash to handle session rotation) ──────────
    const lockValue = await acquireAgentLock(hash);
    if (!lockValue) return; // another agent run is in progress — our message is in history

    try {
      const handled = await tryShortcutOrStateMachine(messageBody, hash, phone, session, log);
      if (handled) return;

      // Load session history AFTER debounce to include all queued messages.
      const history = await loadSession(session.sessionId);
      const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);
      const lastUserMsg = [...trimmedHistory].reverse().find((m) => m.role === "user");
      const agentInput = lastUserMsg?.content || userMessage;

      const lastLocation = await getLastLocation(hash);
      const hints = lgpdJustSent ? ["lgpd_just_sent"] : undefined;
      const context = buildWhatsAppContext(session, lastLocation ?? undefined, hints);

      log.info(
        { phone_hash: hash, session_id: session.sessionId, history_length: trimmedHistory.length },
        "[whatsapp.agent.start]",
      );

      const agentResponse = await collectAgentResponse(
        runOrchestrator(agentInput, trimmedHistory, context),
      );

      log.info(
        {
          phone_hash: hash,
          duration_ms: Date.now() - startMs,
          tools_used: agentResponse.toolsUsed,
          input_tokens: agentResponse.inputTokens,
          output_tokens: agentResponse.outputTokens,
        },
        "[whatsapp.agent.finish]",
      );

      if (agentResponse.statusMessages?.length) {
        log.info({ phone_hash: hash, status_count: agentResponse.statusMessages.length }, "[whatsapp.status_suppressed]");
      }

      // ── Send response ──────────────────────────────────────────────────
      if (agentResponse.text) {
        await sendText(`whatsapp:${phone}`, agentResponse.text);
        await appendMessages(session.sessionId, [
          { role: "assistant", content: agentResponse.text },
        ], true, { customerId: session.customerId, channel: "whatsapp" });
      }

      // ── PIX follow-up: send copia-e-cola + QR code if LLM omitted them ──
      if (agentResponse.pixData) {
        const { pixCopyPaste, pixQrCode } = agentResponse.pixData;
        const textHasPixCode = pixCopyPaste && agentResponse.text?.includes(pixCopyPaste);

        if (pixCopyPaste && !textHasPixCode) {
          await sendText(
            `whatsapp:${phone}`,
            `*Código PIX (copia e cola):*\n\n${pixCopyPaste}\n\n☝️ Copie e cole no app do seu banco.\nNÃO clique — cole no app.`,
          );
        }

        if (pixQrCode) {
          await sendMedia(`whatsapp:${phone}`, pixQrCode, "QR Code PIX").catch((err) => {
            log.warn({ error: String(err) }, "[whatsapp.pix.qr_send_failed] Falling back to text-only PIX");
          });
        }

        const pixOrderId = agentResponse.pixData.orderId;
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
    } catch (err) {
      log.error(err, "[whatsapp.agent.error] Agent processing failed");
      try {
        await sendText(
          `whatsapp:${phone}`,
          "Desculpe, estou com um problema técnico. Tente novamente em alguns instantes.",
        );
      } catch {
        // Best-effort — can't do more
      }
    } finally {
      await releaseAgentLock(hash, lockValue);
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

/**
 * Flag-OFF async WhatsApp turn: runs the legacy brain, then promotes/releases the
 * two-phase idempotency claim the route made (whatsapp-idempotency.ts).
 *
 * The brain self-handles its own errors and returns normally on every real path,
 * so the success branch (promote to the 24h dedup window) is the normal terminal
 * state — matching main, whose route set the 24h key up front. An unexpected throw
 * that escapes the brain releases the claim so Twilio's retry reprocesses (mirrors
 * the conductor path's handleInboundAsync, rather than main's black-hole-on-failure).
 */
export async function handleInboundLegacy(
  body: WaBody,
  messageSid: string,
  log: LogFn,
): Promise<void> {
  const redis = await getRedisClient();
  try {
    await runLegacyTurn(body, log);
    await confirmProcessed(redis, messageSid);
  } catch (err) {
    log.error(err, "[whatsapp.async.legacy.error] Unhandled error");
    await releaseClaim(redis, messageSid).catch(() => {});
  }
}
