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
import { beginWireTurn } from "../claustrum/wire-capture.js";
import {
  mintBroadcastReply,
  mintFallbackReply,
  mintReceiptReply,
  wrapLegacyResponderText,
} from "@adjudicate/core";
import { getRedisClient, rk, atomicIncr, getLoyaltyBalance, getOrCreateCart } from "@ibatexas/tools";
import { Channel } from "@ibatexas/types";
import { beginWorkflowTurn } from "../claustrum/workflow/workflow-turn.js";
import { getConductor } from "../claustrum-bootstrap.js";
// LE2-007 — the funnel's per-turn context (the confirm-window fact only the ingress
// can see). See funnel-tier.ts.
import { closeFunnelTurn, openFunnelTurn } from "../claustrum/funnel-tier.js";
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
import { sendText, sendMedia, type SendCorrelation } from "../whatsapp/client.js";
import {
  classifyTurnDelivery,
  classifyCatchError,
  emitNoDelivery,
  openIncidentInline,
  readPauseState,
  type TurnDisposition,
} from "../conversation/no-delivery.js";
import { closeIncidentOnDeliveredReply } from "../incidents/incident-auto-close.js";
import {
  matchShortcut,
  buildHelpText,
  buildWelcomeText,
  buildLoyaltyText,
  buildOptOutConfirmationText,
  buildOptInConfirmationText,
} from "../whatsapp/shortcuts.js";
import { getBroadcastOptOutStore } from "../broadcast/broadcast-optout.js";
import { LGPD_OPTIN_MESSAGE } from "../whatsapp/constants.js";
import { scheduleHesitationNudge, markCustomerReplied } from "../jobs/hesitation-nudge.js";
import { schedulePixExpiryMonitor } from "../jobs/pix-expiry-monitor.js";
import {
  handleOpsWhatsAppMessage,
  buildOpsWhatsAppIngressDeps,
} from "../ops/ops-whatsapp-ingress.js";

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
  /**
   * True when the bot-pause gate could NOT be read (Redis/store unreachable). The
   * turn was fail-CLOSED suppressed (byte-identical to a genuine pause), but the
   * customer got silence without a confirmed pause → the caller opens a durable
   * `pause_read_error` incident via the Redis-free inline path (W1).
   */
  readonly pauseReadError?: boolean;
  /** `capsule.turnId` — dedup + audit correlation (absent on the pause path). */
  readonly turnId?: string;
  /** `turn.decision.kind` — an `ESCALATE` handoff is never a drop. */
  readonly decisionKind?: string;
  readonly pixData?: {
    pixCopyPaste?: string;
    pixQrCode?: string;
    pixExpiresAt?: string;
    /**
     * BKL-241 — the Stripe PaymentIntent id (`pi_…`) of this PIX attempt: the
     * canonical key for the expiry monitor / `pix:paid:` marker pair.
     */
    paymentIntentId?: string;
    /**
     * `create_checkout`'s tracking id. For PIX this is the SAME `pi_…` id (the
     * web order-read path resolves `pi_`-prefixed ids explicitly) — it is read
     * only as a fallback for producers that do not surface `paymentIntentId`.
     */
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
    const paymentIntentId = typeof r.paymentIntentId === "string" ? r.paymentIntentId : undefined;
    const orderId = typeof r.orderId === "string" ? r.orderId : undefined;
    if (!pixCopyPaste && !pixQrCode) return undefined;
    return { pixCopyPaste, pixQrCode, pixExpiresAt, paymentIntentId, orderId };
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
  // (every WhatsApp send is guarded by `if (response.text)`). Fail-CLOSED, but a
  // pause READ-ERROR is DISTINGUISHED from a genuine pause (W1 Redis-outage fix):
  const pause = await readPauseState(args.sessionKey);
  if (pause === "paused") {
    args.log.info(
      { session: args.sessionKey },
      "[whatsapp] session paused for human takeover — bot reply suppressed",
    );
    return { text: "", disposition: "suppressed_paused" };
  }
  if (pause === "read_error") {
    // Still fail-CLOSED (suppress — a human MIGHT be handling it), but the customer
    // got silence and we could NOT confirm a genuine pause → flag it so the caller
    // opens a pause_read_error incident via the Redis-free inline path. Byte-identical
    // suppressed_paused text so no reply is ever sent.
    args.log.warn(
      { session: args.sessionKey },
      "[whatsapp] bot-pause gate unreachable (Redis?) — suppressing reply + flagging pause_read_error",
    );
    return { text: "", disposition: "suppressed_paused", pauseReadError: true };
  }

  // BKL-066 (review B4 — the WhatsApp plane): ensure a Medusa cart exists for
  // this session BEFORE the turn, mirroring chat.ts. The resolver threads
  // cartId from rk(`cart:active:session:${sessionId}`) with sessionId =
  // cognition.conversationId (ibatexas-resolver.ts), and conversationId here
  // IS args.sessionKey — so the pre-ensure MUST use the same sessionKey or a
  // fresh session's order.item.add still REFUSEs on requireCartIdForCartOps.
  // Idempotent (reuses the session cart after the first turn); the guard is
  // NOT weakened. Never fatal.
  try {
    const realCustomerId = isGuestCustomerId(args.customerId) ? null : args.customerId;
    await getOrCreateCart(
      {},
      {
        channel: Channel.WhatsApp,
        sessionId: args.sessionKey,
        ...(realCustomerId ? { customerId: realCustomerId } : {}),
        userType: realCustomerId ? "customer" : "guest",
      },
    );
  } catch (err) {
    args.log.warn({ err }, "[whatsapp] cart pre-ensure failed (non-fatal)");
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
    // ── NO PARK-REPLY TRIAGE HERE — a recorded OPT-OUT, not an oversight ───────
    // The other three ingresses (ops-whatsapp-ingress.ts, routes/admin/ops-chat.ts,
    // routes/chat.ts) triage an inbound reply against the session's parked
    // confirmations BEFORE handleTurn, and since R4-S1 that decision has a single
    // owner: ../claustrum/park-reply-triage.ts. This plane deliberately does NOT
    // consume it, so the gap is live and named:
    //   - a customer "não" on a parked confirmation still reaches the PLANNER, and
    //     claustrum's deny path unparks and then re-plans the "no" as a fresh
    //     command — the BKL-191 re-prompt class, closed on the other three surfaces
    //     (BKL-191 at ops, BKL-212 at web) and STILL OPEN here;
    //   - a bare soft "ok" needs no restate branch on this plane: unlike web, the
    //     `@claustrum/channel-whatsapp` driver CONFIRMS on a bare "ok" BY DESIGN
    //     (see web-confirm-channel.ts's header), so a courtesy token here resumes
    //     the park through the fully-adjudicated path already.
    // Wiring the decline branch would change what a customer's "não" DOES on the
    // highest-traffic plane, so it is an OWNER decision (a behaviour change), not a
    // refactor. The module now exists and this plane needs only a policy — see
    // `webCustomerParkTriagePolicy` and the NOT WIRED note in its header.
    //
    // LE2-007 — publish this turn's FUNNEL CONTEXT (the WhatsApp customer mirror of
    // routes/chat.ts). The confirm-window fact is the one thing the funnel's L0 tier
    // cannot see from inside the loop (`CognitiveState` carries no session), and
    // FE-D32 says L0 must not fire at all while a confirmation is parked. This plane
    // needs the gate MORE than web does, not less: its channel driver confirms on a
    // bare "ok" by design (see web-confirm-channel.ts's header), so courtesy tokens
    // during a park are load-bearing here. Absent this publish the tier is
    // fail-closed (no L0), never fail-open.
    openFunnelTurn(capsule.turnId, {
      confirmWindowOpen:
        (capsule.loadedSession?.pendingConfirmations?.length ?? 0) > 0,
    });
    // LE2-021 — bind this turn for the workflow decision observer (the web
    // mirror is routes/chat.ts). This plane makes the concurrency argument
    // concrete: webhook deliveries for different customers are handled in
    // parallel in one process, so a module-scope binding would cross-bind their
    // confirms. See workflow/workflow-turn.ts.
    const turn = await beginWireTurn(() =>
      beginWorkflowTurn({ turnId: capsule.turnId, channel: "whatsapp" }, () =>
        handleTurn(capsule, inbound),
      ),
    );
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
    if (disposition !== "deliverable") {
      // PAYLOAD-1 / Defect C: the model returned an empty/whitespace completion,
      // so without a holding message the customer is ghosted. Emit a queryable
      // warn at the SOURCE (previously there were ZERO VictoriaLogs lines for
      // this failure) — an operator can now find + RCA every ghost by turnId via
      // `component:llm event:empty`. Token cost/model join via the turn line.
      args.log.warn(
        {
          component: "llm",
          event: "empty",
          turnId: capsule.turnId,
          session_id: args.sessionKey,
          disposition,
          decisionKind: turn.decision.kind,
        },
        `llm empty completion (${disposition})`,
      );
    }
    return {
      text: rawText,
      disposition,
      turnId: capsule.turnId,
      decisionKind: turn.decision.kind,
      ...(pixData ? { pixData } : {}),
    };
  } finally {
    // LE2-007 — drop this turn's funnel state (LRU-capped store; this is hygiene).
    closeFunnelTurn(capsule.turnId);
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
      // LE2-030 — correlate the captured Twilio SID to this (retry) turn.
      await sendText(`whatsapp:${phone}`, wrapLegacyResponderText(retryResponse.text), {
        turnId: retryResponse.turnId ?? null,
        conversationId: session.sessionId,
      });
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

export interface SignatureError {
  code: number;
  error: string;
  logMessage: string;
}

/**
 * Verify Twilio's `X-Twilio-Signature` over the posted form params.
 *
 * LE2-030 — EXPORTED and URL-parameterized so the delivery-status callback
 * route (`whatsapp-status-callback.ts`) validates its callbacks through THIS
 * function rather than a second copy of the rule. `opts.webhookUrl` defaults to
 * `TWILIO_WEBHOOK_URL` so the inbound call site is unchanged; the callback route
 * passes its own URL (Twilio signs the exact URL it posted to, and the two
 * endpoints have different paths). `opts.logTag` namespaces the log line and
 * `opts.urlEnvVar` names the missing var in the misconfiguration message.
 */
export function verifyTwilioSignature(
  request: FastifyRequest,
  body: Record<string, unknown>,
  opts?: {
    readonly webhookUrl?: string | undefined;
    readonly logTag?: string;
    readonly urlEnvVar?: string;
  },
): SignatureError | null {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  // D-AUTHURL: webhookUrl MUST be the exact public URL Twilio posted to — it is
  // hashed verbatim with the sorted POST params into X-Twilio-Signature. No proxy
  // rewrite, no extra query string, and http/https must match byte-for-byte, or
  // verifyTwilioSignature below rejects every request. The shape (no query, https
  // in prod) is asserted at startup in ../config.ts; see .env.example for the full
  // contract.
  const webhookUrl = opts?.webhookUrl ?? process.env.TWILIO_WEBHOOK_URL;
  const tag = opts?.logTag ?? "whatsapp.incoming";
  const urlEnvVar = opts?.urlEnvVar ?? "TWILIO_WEBHOOK_URL";

  if (!authToken || !webhookUrl) {
    return { code: 500, error: "Webhook not configured", logMessage: `[whatsapp.config] TWILIO_AUTH_TOKEN or ${urlEnvVar} not set` };
  }

  const signature = request.headers["x-twilio-signature"];
  if (typeof signature !== "string") {
    return { code: 400, error: "Missing signature", logMessage: `[${tag}] Missing X-Twilio-Signature` };
  }

  const isValid = twilio.validateRequest(authToken, signature, webhookUrl, body as Record<string, string>);
  if (!isValid) {
    return { code: 403, error: "Invalid signature", logMessage: `[${tag}] Invalid Twilio signature` };
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

export async function handleShortcut(
  shortcutType: string,
  ctx?: { customerId?: string; sessionId: string; phone?: string; log?: LogFn },
): Promise<string | null> {
  switch (shortcutType) {
    case "help":
      return buildHelpText();
    case "welcome":
      return buildWelcomeText();
    case "optout":
    case "optin": {
      // WS3A — customer-initiated marketing opt-out/opt-in (STOP/voltar). Write
      // durable consent keyed by the canonical phone, then confirm in pt-BR. On a
      // write failure, fall through to the agent rather than ghosting/erroring.
      if (!ctx?.phone) return null;
      try {
        const store = await getBroadcastOptOutStore();
        if (shortcutType === "optout") {
          await store.optOut(ctx.phone, "inbound_stop");
          return buildOptOutConfirmationText();
        }
        await store.optIn(ctx.phone, "inbound_stop");
        return buildOptInConfirmationText();
      } catch (consentErr) {
        // LGPD: a dropped inbound consent write (opt-OUT is legally significant)
        // must never be swallowed silently — emit a structured error so it is
        // visible in logs/alerting and reconstructable (phone hash + direction).
        // We still fall through to the agent so the customer is never ghosted.
        ctx.log?.error(
          {
            component: "whatsapp",
            event: "consent_write_failed",
            direction: shortcutType, // "optout" | "optin"
            phone_hash: hashPhone(ctx.phone),
            error: String(consentErr),
          },
          "[whatsapp.consent] Inbound consent write failed — LGPD opt-out/opt-in may be dropped",
        );
        return null;
      }
    }
    case "loyalty": {
      // CUS-067: answer loyalty keywords (fidelidade/selos/pontos) with the
      // REAL stamp balance instead of deflecting to the agent (a dead L2 read
      // tool). Read-only. Guests (no customerId) get the login-prompt copy.
      if (!ctx?.customerId) return buildLoyaltyText();
      try {
        const balance = await getLoyaltyBalance(
          {},
          { channel: Channel.WhatsApp, sessionId: ctx.sessionId, customerId: ctx.customerId, userType: "customer" },
        );
        return balance.message;
      } catch {
        // Loyalty service unavailable — fall through to the agent rather than
        // ghosting or erroring the customer.
        return null;
      }
    }
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
      const signatureError = verifyTwilioSignature(request, body as Record<string, unknown>);
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

      // SIGNAL-3: tag the WhatsApp entry point so VMUI can slice it
      // (component:whatsapp event:incoming). The customer's message TEXT is
      // shipped — redacted + clipped — on the conductor turn line (see emitTurn),
      // so here we log only its LENGTH to avoid duplicating PII into the store.
      server.log.info(
        {
          component: "whatsapp",
          event: "incoming",
          phone_hash: hash,
          message_sid: messageSid,
          text_len: messageBody.length,
          processing_ms: Date.now() - startMs,
        },
        "[whatsapp.incoming] Message received",
      );

      // ── 4. Idempotency (BEFORE rate limit) — two-phase (P2-SEC-WAIDEMPOTENCY) ─
      const redis = await getRedisClient();
      const claim = await claimIdempotency(redis, messageSid);
      if (claim === "unavailable") {
        server.log.error({ component: "whatsapp", event: "idempotency_unavailable", message_sid: messageSid }, "[whatsapp] Idempotency claim unavailable — failing closed for Twilio retry");
        return reply.code(503).send({ error: "Service unavailable" });
      }
      if (claim === "duplicate") {
        server.log.info({ component: "whatsapp", event: "duplicate", message_sid: messageSid }, "[whatsapp.duplicate] Already processed");
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
    const response = await handleShortcut(shortcut.type, {
      customerId: session.customerId,
      sessionId: session.sessionId,
      phone,
      log,
    });
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

/**
 * PIX follow-up: send copia-e-cola + QR code if the LLM omitted them, then schedule
 * expiry reminders. Returns whether a PIX artifact actually REACHED the customer
 * (send success) — NOT merely whether the payload was present — so `deliveredText`
 * reflects reality when a PIX-only send fails (below-cap d).
 *
 * `track` wires the copia-e-cola send into the caller's sendEntered/sendCompleted
 * flags (#5): on a PIX-only turn (no text was sent, `sendEntered` still false) a
 * THROW here would otherwise land in the outer catch as `turn_error` and open NO
 * incident — a customer ghosted on a payment turn. Marking the send as entered
 * (but not completed) makes the catch classify it `send_failed` (customerImpacted,
 * opens an incident).
 */
async function sendPixFollowUp(
  pixData: NonNullable<WhatsAppTurn["pixData"]>,
  agentText: string,
  phone: string,
  hash: string,
  session: WaSession,
  log: LogFn,
  track?: { readonly onEnter: () => void; readonly onComplete: () => void },
  // LE2-030 — the turn this PIX artifact belongs to, so the copia-e-cola part
  // and the QR media send land in the delivery store under the same turn_id.
  correlation?: SendCorrelation,
): Promise<boolean> {
  const { pixCopyPaste, pixQrCode } = pixData;
  const textHasPixCode = pixCopyPaste && agentText.includes(pixCopyPaste);
  // The code already rode along in the (delivered) agent text → already delivered.
  let pixDelivered = Boolean(textHasPixCode);

  if (pixCopyPaste && !textHasPixCode) {
    track?.onEnter();
    await sendText(
      `whatsapp:${phone}`,
      mintReceiptReply(
        `*Código PIX (copia e cola):*\n\n${pixCopyPaste}\n\n☝️ Copie e cole no app do seu banco.\nNÃO clique — cole no app.`,
      ),
      correlation,
    );
    track?.onComplete();
    pixDelivered = true;
  }

  if (pixQrCode) {
    // EGRESS BRAND (Plan 1 / F4): mint the customer-facing caption at the
    // producer; sendMedia no longer mints prose internally.
    await sendMedia(`whatsapp:${phone}`, pixQrCode, mintReceiptReply("QR Code PIX"), correlation)
      .then(() => {
        pixDelivered = true;
      })
      .catch((err) => {
        log.warn({ error: String(err) }, "[whatsapp.pix.qr_send_failed] Falling back to text-only PIX");
      });
  }

  // Schedule PIX expiry reminders (25min reminder + 30min expired).
  //
  // BKL-241: keyed by the PaymentIntent id — the same id the Stripe webhook
  // writes the `pix:paid:` marker under, so payment actually silences these
  // jobs. The previous `|| session.customerId` fallback is GONE: a monitor
  // keyed on a customer id can never match that marker, so it was guaranteed
  // to tell a paying customer "O PIX expirou". With no id the paid-check is
  // unanswerable, so we schedule nothing rather than schedule a false claim.
  const pixPaymentIntentId = pixData.paymentIntentId ?? pixData.orderId;
  if (pixCopyPaste && pixPaymentIntentId) {
    void schedulePixExpiryMonitor({
      phone,
      phoneHash: hash,
      paymentIntentId: pixPaymentIntentId,
    }).catch((err) => {
      log.warn({ error: String(err) }, "[whatsapp.pix.expiry_schedule_failed]");
    });
  } else if (pixCopyPaste) {
    log.warn(
      { session: session.sessionId },
      "[whatsapp.pix.expiry_schedule_skipped] PIX artifact carries no payment intent id",
    );
  }

  return pixDelivered;
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

  // ── Ops-actor fork (BKL-086) — BEFORE any customer-path work ───────────────
  // An ACTIVE staff phone runs the ops manager plane (the owner commands the
  // restaurant by message). This MUST precede resolveWhatsAppSession below,
  // which auto-creates a Customer + welcome credit + LGPD opt-in — side effects
  // an owner command must never trigger. A non-staff / inactive phone returns
  // {consumed:false} and falls through to the customer path BYTE-IDENTICALLY.
  // On success (consumed) we mark the idempotency claim as done so a stray SID
  // redelivery never re-fires a mutating owner command, then return.
  const opsOutcome = await handleOpsWhatsAppMessage(
    buildOpsWhatsAppIngressDeps(phone, log),
    { phone, hash, text: messageBody, log },
  );
  if (opsOutcome.consumed) {
    succeeded = true;
    return;
  }

  // ── Cancel any pending hesitation nudge on incoming message ────────────────
  await markCustomerReplied(hash);

  // ── Media handling ──────────────────────────────────────────────────────────
  if (numMedia > 0 && !messageBody) {
    // BKL-175 (BKL-134 residual) — best-effort, not bare sendText: a Twilio
    // failure here used to escape to the incident-less outer catch. The reply is
    // deterministic and pre-session, so best-effort is the strongest available
    // posture (no session yet → no well-formed NoDeliverySignal to open).
    await sendBestEffort(
      `whatsapp:${phone}`,
      "Recebi sua mídia 👍\n\nAinda não consigo analisar imagens ou áudio.\nPode me explicar em palavras?",
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
  // Detached auto-close promise (L10) — CAPTURED so the inner finally can await it
  // before the post-lock retry, so a stale delivered-reply close cannot race a NEW
  // incident the retry opens.
  let closePromise: Promise<void> | undefined;
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

    // ── Pause-gate READ-ERROR (W1 Redis-outage fix) ────────────────────────
    // The bot-pause gate was unreachable, so the reply was fail-CLOSED suppressed
    // WITHOUT a confirmed pause → the customer got silence. Open a durable
    // `pause_read_error` incident via the Redis-FREE inline path (openIncidentInline
    // routes through the pure kernel + a DB-side replay guard, never the Redis dedup
    // layer — so it does NOT no-op in the very outage it exists for). Storm-bounded
    // by the per-session open-incident partial unique index (a second message on the
    // same session increments, never re-opens); notifications aggregate via the storm
    // digest (conversation.incident_opened → the notification subscriber), NOT a
    // bespoke per-incident ping here.
    if (agentResponse.pauseReadError) {
      succeeded = true; // intentional suppression — do not trigger a Twilio retry
      const signal = {
        sessionId: session.sessionId,
        cause: "pause_read_error" as const,
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
      return;
    }

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
      // LE2-030 — the turn correlation the delivery store joins on. Purely
      // additive: `sendText` records the returned SID against this turn_id and
      // part index, and changes nothing about the send itself.
      await sendText(`whatsapp:${phone}`, wrapLegacyResponderText(agentResponse.text), {
        turnId: agentResponse.turnId ?? null,
        conversationId: session.sessionId,
      });
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
    // Track the copia-e-cola send (#5) so a failed PIX-only delivery is classified
    // send_failed in the outer catch; capture whether a PIX artifact actually
    // reached the customer (below-cap d) rather than trusting payload presence.
    let pixDelivered = false;
    if (agentResponse.pixData) {
      pixDelivered = await sendPixFollowUp(
        agentResponse.pixData,
        agentResponse.text,
        phone,
        hash,
        session,
        log,
        {
          onEnter: () => {
            sendEntered = true;
          },
          onComplete: () => {
            sendCompleted = true;
          },
        },
        // LE2-030 — same turn correlation as the text reply above.
        { turnId: agentResponse.turnId ?? null, conversationId: session.sessionId },
      );
    }

    // ── No-delivery reconcile (AFTER the PIX block — false-positive fix) ──
    // PIX copia-e-cola + QR is delivered regardless of text, so a turn with empty
    // text but a SUCCESSFULLY-SENT PIX artifact DID reach the customer.
    // `deliveredText` keys the genuine-drop decision on what actually reached the
    // customer — driven by real send success (`pixDelivered`), not payload presence.
    const deliveredText = textSent || pixDelivered;

    // SIGNAL-8: one queryable per-turn outbound line — did a reply actually
    // reach the customer? Joinable to the conductor turn by turnId. warn when
    // NOTHING was delivered (a ghost/degraded turn); info on the happy path AND
    // on a designed human-takeover pause (suppressed_paused) — the bot is
    // intentionally silent then, so it must NOT pollute the ghost-detection
    // `event:reply.sent level:warn` query (it also has no turnId to join on).
    const designedSilence = agentResponse.disposition === "suppressed_paused";
    log[deliveredText || designedSilence ? "info" : "warn"](
      {
        component: "outbound",
        event: "reply.sent",
        turnId: agentResponse.turnId ?? null,
        session_id: session.sessionId,
        channel: "whatsapp",
        disposition: agentResponse.disposition,
        decisionKind: agentResponse.decisionKind ?? null,
        deliveredText,
        textSent,
        pixDelivered,
      },
      `reply ${deliveredText ? "delivered" : "NOT delivered"} (${agentResponse.disposition})`,
    );

    // ── Auto-close (Q2): a successfully-delivered reply self-heals an OPEN
    // incident on this session → AUTO_RESOLVED. Gated on the SAME delivered
    // predicate as detection (REVIEW-v2: a PIX-only recovery must close too, so
    // this sits OUT of the `if (agentResponse.text…)` text gate). Fail-open,
    // idempotent, fast-null on the happy path. ──
    if (deliveredText && agentResponse.turnId) {
      // Detached (L10): the close is fail-open + idempotent, so it must NOT be
      // awaited on the hot path — awaiting a DB lookup on every delivered reply
      // extends the lock-hold and gates finally/lock-release/finalizeIdempotency.
      // CAPTURED (not fully fire-and-forget): the inner finally awaits it AFTER the
      // lock is released but BEFORE the post-lock retry, so it can't race (and
      // wrongly auto-resolve) a NEW incident the retry opens. `.catch` keeps it
      // non-throwing so the awaiting finally never breaks.
      closePromise = closeIncidentOnDeliveredReply(session.sessionId, agentResponse.turnId, log).catch(
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
    // BKL-175 — never-silent PARITY with the web backstop (chat.ts): a PRE-SEND
    // escape (`!sendEntered` — the turn died before any reply left) is mapped
    // INTO the frozen taxonomy as `send_failed` and opens a governed incident,
    // exactly as web's catch-block does. Only the POST-send `turn_error`
    // (already-served, F2) stays incident-less — the customer got the reply.
    if (cause === "timeout" || cause === "send_failed" || !sendEntered) {
      // Send the canned apology FIRST and track whether it actually reached the
      // customer: a delivered apology means this is NOT a full ghost (degraded, not
      // silence) → customerImpacted:false (mirrors the delivered-holding case). The
      // send is fully guarded, so it can never mask the governed open below.
      let apologyDelivered = false;
      try {
        await sendText(
          `whatsapp:${phone}`,
          mintFallbackReply(
            "Desculpe, estou com um problema técnico. Tente novamente em alguns instantes.",
          ),
        );
        apologyDelivered = true;
      } catch {
        // Twilio down — the customer got silence (a full ghost).
      }
      const signal = {
        sessionId: session.sessionId,
        // BKL-175 — map the out-of-taxonomy pre-send `turn_error` into the
        // frozen `send_failed` (mirrors web chat.ts's catch mapping); `timeout`
        // keeps its own cause.
        cause: cause === "timeout" ? ("timeout" as const) : ("send_failed" as const),
        customerImpacted: !apologyDelivered,
        channel: "whatsapp",
        customerId: session.customerId,
        senderRef: `whatsapp:${phone}`,
        phoneHash: hash,
        turnId: null,
        messageSid: body.MessageSid ?? null,
      };
      await emitNoDelivery(signal, log);
      await openIncidentInline(signal, log);
    } else {
      // POST-send turn_error ONLY (sendEntered — the customer was already served;
      // F2 already-served exclusion): canned apology, never an incident. The
      // pre-send arm above (BKL-175) now owns every silent-exit path.
      await sendBestEffort(
        `whatsapp:${phone}`,
        "Desculpe, estou com um problema técnico. Tente novamente em alguns instantes.",
      );
    }
  } finally {
    await releaseAgentLock(hash, lockValue);
    // L10 race guard: await the detached delivered-reply auto-close AFTER the lock
    // is released (so it never extended lock-hold) but BEFORE the post-lock retry —
    // otherwise a stale close could race and wrongly auto-resolve a NEW incident the
    // retry opens (below-cap: the L10 detach could escape the lock/finalize).
    if (closePromise) await closePromise;
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
