// Chat routes — thin delegate over the @claustrum/* Conductor (WS7 cutover).
//
// POST /api/chat/messages — accept a user message, start the conductor turn,
//                           return messageId (+ token/secret).
// GET  /api/chat/stream/:sessionId — SSE stream of the agent response chunks.
//
// The orchestration was previously `runOrchestrator(...)` (a StreamChunk
// generator from @ibatexas/llm-provider). WS7 swaps it for the claustrum
// Conductor:
//
//   conductor.openCapsule({ channel: "web", customerId, sessionKey, inbound })
//   handleTurn(capsule, inbound)  → TurnResult { response, decision, ... }
//   conductor.closeCapsule(capsule)
//
// Streaming "Option A": `handleTurn` returns a single assembled
// `RenderedResponse` (not a generator), so the route pushes one
// `text_delta` chunk + a terminal `done`. Per-token streaming is a follow-up
// that wires the WebChannel.sink into openCapsule.
//
// EVERY dev hardening item is preserved:
//   - POST: session-ownership + x-session-token verify (403); guest-session
//     secret (1h TTL) + x-session-secret verify (403); acquireWebAgentLock
//     → 409; session:lastActivity; createStream; appendMessages(user) BEFORE
//     + appendMessages(assistant) AFTER (the claustrum SessionPort save/load
//     are TODO stubs — history persistence stays on dev's Redis session
//     store); releaseWebAgentLock in finally.
//   - GET: reply.hijack() + SSE headers + buffered-chunk replay + terminal
//     chunk + close cleanup + CORS allowlist + guest-secret check +
//     keep-alive heartbeat + per-session AbortController + subscribeToStream
//     cross-replica path.

import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { handleTurn, type ChannelMessage } from "@claustrum/core";
import { beginWireTurn } from "../claustrum/wire-capture.js";
import { mintFallbackReply, wrapLegacyResponderText } from "@adjudicate/core";
import { Channel, type StreamChunk } from "@ibatexas/types";
import { getRedisClient, rk, createSessionToken, verifySessionToken, getOrCreateCart } from "@ibatexas/tools";
import { loadSession, appendMessages } from "../session/store.js";
import { optionalAuth } from "../middleware/auth.js";
import {
  createStream,
  pushChunk,
  getStream,
  subscribeToStream,
  cleanupStream,
  chunkToWire,
} from "../streaming/emitter.js";
import { acquireWebAgentLock, releaseWebAgentLock } from "../streaming/execution-queue.js";
import { getConductor } from "../claustrum-bootstrap.js";
import {
  WEB_NEGATIVE_DECLINE_ACK_PTBR,
  webNegativeDeclineTarget,
  webSoftAffirmativeRestateNotice,
} from "../claustrum/web-confirm-channel.js";
import {
  classifyTurnDelivery,
  classifyCatchError,
  emitNoDelivery,
  openIncidentInline,
  readPauseState,
  type LogFn,
  type NoDeliveryClassification,
  type NoDeliverySignal,
  type TurnDisposition,
} from "../conversation/no-delivery.js";
import { closeIncidentOnDeliveredReply } from "../incidents/incident-auto-close.js";

const PostMessageBody = z.object({
  sessionId: z.uuid(),
  message: z.string().min(1).max(2000),
  channel: z.enum(Channel),
});

const PostMessageResponse = z.object({
  messageId: z.uuid(),
  sessionToken: z.string().optional(),
  sessionSecret: z.string().optional(),
});

const StreamParams = z.object({
  sessionId: z.uuid(),
});

// ── CORS allowlist for the SSE endpoint (P2-SEC-SSECORS) ──────────────────────
// The SSE GET is `reply.hijack()`-ed, so the global @fastify/cors plugin (which
// only sets ACAO on non-hijacked replies) never runs for it. We must therefore
// reproduce the SAME allowlist here rather than reflecting an arbitrary Origin
// with Allow-Credentials (which would let any site read an authenticated stream).
//
// This MIRRORS `resolveOrigin()` in ../plugins/cors.ts — kept env-identical
// (CORS_ORIGIN → NODE_ENV dev LAN regexes → WEB_URL) so the two cannot diverge.
function resolveAllowedOrigins(): string[] | RegExp[] | true {
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    return corsOrigin.includes(",")
      ? corsOrigin.split(",").map((o) => o.trim())
      : [corsOrigin];
  }

  if (process.env.NODE_ENV !== "production") {
    return [
      /^http:\/\/localhost(:\d+)?$/,
      /^http:\/\/127\.0\.0\.1(:\d+)?$/,
      /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
    ];
  }

  const webUrl = process.env.WEB_URL;
  if (!webUrl) {
    throw new Error("WEB_URL environment variable is required in production");
  }
  return [webUrl];
}

/** True if `origin` is permitted by the configured allowlist. */
function isOriginAllowed(origin: string): boolean {
  const allowed = resolveAllowedOrigins();
  if (allowed === true) return true;
  return allowed.some((entry) =>
    entry instanceof RegExp ? entry.test(origin) : entry === origin,
  );
}

// ── SSE keep-alive heartbeat (P2-MEM-SSEHEARTBEAT) ────────────────────────────
// The hijacked SSE response only reacts to a *clean* socket close via
// `request.raw.on("close", …)`. A half-open socket (NAT/LB idle drop, dead
// peer) never fires "close", so without proactive traffic the connection — and
// its in-memory emitter listener / Redis subscriber — can leak indefinitely.
// We write a periodic SSE comment line (`: ping\n\n`, ignored by EventSource)
// to keep intermediaries from idling the socket and to surface a dead peer as a
// write error (which our error path then cleans up). The interval is ALWAYS
// cleared on close/error/terminal-chunk so no interval is ever orphaned.
// Read at request time (mirrors resolveAllowedOrigins) so it stays env-driven
// (rule 3). 0/negative disables the heartbeat.
function resolveSseHeartbeatMs(): number {
  return Number.parseInt(
    process.env.SSE_HEARTBEAT_MS || "15000", // 15s — below typical 30-60s LB idle
    10,
  );
}

// ── Per-session turn abort registry (P2-CONC-ABORT) ───────────────────────────
// The producer (POST) fires the agent turn fire-and-forget; the SSE consumer
// (GET) is a *separate* request. When the consumer disconnects we want to stop
// wasting work and, crucially, avoid letting the turn deliver side effects
// after the client is gone. We key an AbortController by sessionId so the GET's
// "close" handler can signal the POST's in-flight turn.
//
// NOTE: producer and consumer may land on DIFFERENT replicas (see emitter.ts).
// This registry is in-process, so it only propagates disconnects on the
// same-replica fast path — the common single-replica case. Cross-replica abort
// would need a Redis signal and is intentionally out of scope.
const turnAbortControllers = new Map<string, AbortController>();

// ── POST helpers (S3776: keep the route handler's cognitive complexity low) ───

/** Send a 403 Forbidden with a pt-BR message. */
function sendForbidden(reply: FastifyReply, message: string): void {
  void (reply as unknown as { status(code: number): typeof reply }).status(403).send({
    statusCode: 403,
    error: "Forbidden",
    message,
  } as never);
}

/**
 * Session-ownership verification (zero-trust). Returns true if the request was
 * rejected (a 403 has been sent) and the caller must stop. On success the owner
 * key is (re)asserted with a 24h TTL.
 */
async function rejectOnOwnershipFailure(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  sessionId: string,
  customerId: string,
  tokenHeader: string | undefined,
  reply: FastifyReply,
): Promise<boolean> {
  const ownerKey = rk(`session:owner:${sessionId}`);
  const existingOwner = await redis.get(ownerKey);

  if (tokenHeader) {
    const claim = verifySessionToken(tokenHeader);
    if (claim?.sessionId !== sessionId || claim?.customerId !== customerId) {
      sendForbidden(reply, "Token de sessão inválido.");
      return true;
    }
  }

  if (existingOwner && existingOwner !== customerId) {
    sendForbidden(reply, "Sessão pertence a outro usuário.");
    return true;
  }

  await redis.set(ownerKey, customerId, { EX: 86400 });
  return false;
}

/**
 * Guest session secret (prevents session hijacking). On a first request it mints
 * + stores a 1h secret (returned to echo to the client); on a subsequent request
 * it verifies the provided secret, rejecting (403) on mismatch.
 */
async function resolveGuestSecret(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  sessionId: string,
  providedSecret: string | undefined,
  reply: FastifyReply,
): Promise<{ rejected: boolean; secret?: string }> {
  const secretKey = rk(`session:secret:${sessionId}`);
  const existingSecret = await redis.get(secretKey);

  if (existingSecret) {
    // Subsequent request — verify secret
    if (providedSecret !== existingSecret) {
      sendForbidden(reply, "Segredo de sessão inválido.");
      return { rejected: true };
    }
    return { rejected: false };
  }

  // First request — generate and store secret
  const secret = crypto.randomUUID();
  await redis.set(secretKey, secret, { EX: 3600 });
  return { rejected: false, secret };
}

// ── Web/chat no-reply seam (W1 no-reply incident, P1-9) ───────────────────────
// The WEB analog of the WhatsApp empty/failure substitution (whatsapp-webhook.ts
// classify→emit→open→holding). It REUSES the shared machinery in
// ../conversation/no-delivery.ts (classifyTurnDelivery + emitNoDelivery +
// openIncidentInline) — never a copy — so the web plane opens the SAME governed,
// audited, deduped incident through the SAME kernel chokepoint as WhatsApp.
//
// `WEB_EMPTY_COMPLETION_HOLDING` is the web sibling of `WA_EMPTY_COMPLETION_HOLDING`:
// when enabled, the bare `{type:"done"}` is preceded by ONE pt-BR holding chunk so
// the customer never faces a pure void. Read at turn time (mirrors
// resolveSseHeartbeatMs) so it stays env-driven (Hard Rule #3).
function isWebEmptyHoldingEnabled(): boolean {
  return process.env.WEB_EMPTY_COMPLETION_HOLDING === "true";
}

/** pt-BR holding copy (web variant of WA_HOLDING_MESSAGE_PTBR; `digite` not `responda`). */
const WEB_HOLDING_MESSAGE_PTBR =
  "Desculpe, não consegui montar uma resposta agora. Pode tentar de novo? Se preferir, digite *menu* para ver as opções ou *ajuda* para falar com a gente.";

/**
 * PURE. Map a web turn's assembled text to a {@link TurnDisposition}. The
 * intentional bot-pause (`suppressed_paused`) is excluded by construction — it
 * returns BEFORE openCapsule, so it never reaches this seam. Web has no PIX/
 * media side-channel on this route, so disposition is derived from text alone.
 */
function webDisposition(text: string | null | undefined): TurnDisposition {
  if (typeof text === "string" && text.trim().length > 0) return "deliverable";
  if (typeof text === "string" && text.length > 0) return "whitespace_only";
  return "empty_completion";
}

/**
 * FAIL-OPEN. On a genuine web drop, fan out the notification + open the durable
 * governed incident. Web has NO `messageSid`; the per-turn `turnId` (from the
 * capsule) is the primary dedup key — `deriveEventId` prefers it — and the web
 * `messageId` is carried as the messageSid-equivalent fallback (honoring "web has
 * no messageSid"). NEVER throws: the SSE response must not break on an open
 * failure (emitNoDelivery / openIncidentInline are already no-throw; the wrapper
 * is defense in depth).
 */
async function openWebDrop(params: {
  sessionId: string;
  messageId: string;
  customerId: string | undefined;
  turnId: string | undefined;
  decisionKind: string | undefined;
  classification: NoDeliveryClassification;
  log: LogFn;
}): Promise<void> {
  const { sessionId, messageId, customerId, turnId, decisionKind, classification, log } = params;
  try {
    const signal: NoDeliverySignal = {
      sessionId,
      cause: classification.cause,
      customerImpacted: classification.customerImpacted,
      channel: "web",
      customerId: customerId ?? null,
      // No phone on web — the session is the channel-addressable handle.
      senderRef: `web:${sessionId}`,
      phoneHash: null,
      turnId: turnId ?? null,
      decisionKind: decisionKind ?? null,
      // Web has no Twilio MessageSid; carry the per-request messageId as the
      // dedup fallback for the (rare) no-turnId path.
      messageSid: messageId,
    };
    // Ordered emit → open. The customer-facing fallback chunk is pushed by the
    // caller STRICTLY AFTER this, so a substitution can never mask emission.
    await emitNoDelivery(signal, log);
    await openIncidentInline(signal, log);
  } catch (err) {
    log.error(err, "[chat] web no-delivery open failed (fail-open; SSE continues)");
  }
}

/**
 * BKL-212 — deliver ONE deterministic, ingress-authored pt-BR reply (a
 * confirm-resume nicety) on the SSE stream. Mirrors the normal path's frame order
 * and branding exactly — `text_delta` (branded through the same transitional
 * minter) → persist → terminal `done` — so the client cannot tell an
 * ingress-answered turn from a conductor-answered one. Abort-aware like every
 * other delivery here: a disconnected/superseded consumer gets nothing (and
 * nothing is persisted for it). The history append is best-effort, matching the
 * ops precedent — a store failure must never cost the customer the reply.
 */
async function deliverIngressReply(params: {
  server: FastifyInstance;
  sessionId: string;
  text: string;
  customerId: string | undefined;
  isAuthenticated: boolean;
  aborted: boolean;
}): Promise<void> {
  const { server, sessionId, text, customerId, isAuthenticated, aborted } = params;
  if (aborted) return;
  pushChunk(sessionId, { type: "text_delta", delta: wrapLegacyResponderText(text) });
  try {
    await appendMessages(sessionId, [{ role: "assistant", content: text }], isAuthenticated, {
      customerId,
      channel: "web",
    });
  } catch (err) {
    server.log.warn(err, "[chat] ingress-reply history append failed (non-fatal)");
  }
  pushChunk(sessionId, { type: "done" });
}

/**
 * Delegate one turn to the claustrum Conductor (fire-and-forget). Mirrors dev's
 * hardening: bot-pause gate, single assembled text chunk + terminal done,
 * assistant-message persistence, abort-aware delivery, and finally cleanup.
 */
async function runConductorTurn(params: {
  server: FastifyInstance;
  sessionId: string;
  message: string;
  messageId: string;
  customerId: string | undefined;
  isAuthenticated: boolean;
  turnAbort: AbortController;
}): Promise<void> {
  const { server, sessionId, message, messageId, customerId, isAuthenticated, turnAbort } = params;
  // Hoisted so the outer catch (F2 — WhatsApp :899 parity) can tell a throw that
  // happened BEFORE the conductor produced a result (a genuine drop the inner
  // classify never saw) from a post-result throw (e.g. closeCapsule after the
  // reply was already classified+delivered — the inner path owns that decision).
  let turnHandled = false;
  try {
    // D2 bot-pause gate: once a human takes over this session (an open
    // escalation), the LLM must stop auto-replying. The user's inbound was
    // already archived above (appendMessages(user)), so staff still see it; we
    // just suppress the bot turn. Fail-CLOSED, but a pause READ-ERROR is
    // DISTINGUISHED from a genuine pause (W1 Redis-outage fix):
    const pause = await readPauseState(sessionId);
    if (pause === "paused") {
      pushChunk(sessionId, { type: "done" });
      return;
    }
    if (pause === "read_error") {
      // Still fail-CLOSED (suppress — a human MIGHT be handling it), but the
      // customer got silence without a confirmed pause → open a durable
      // pause_read_error incident via the Redis-FREE inline path (openIncidentInline
      // routes through the pure kernel + a DB-side replay guard, never the Redis
      // dedup layer). Storm-bounded by the per-session partial unique index;
      // notifications aggregate via the storm digest, never a per-incident ping.
      await openWebDrop({
        sessionId,
        messageId,
        customerId,
        turnId: undefined,
        decisionKind: undefined,
        classification: { cause: "pause_read_error", customerImpacted: true },
        log: server.log,
      });
      pushChunk(sessionId, { type: "done" });
      return;
    }

    const conductor = getConductor();
    const turnCustomerId = customerId ?? `guest:${sessionId}`;

    // BKL-066: ensure a Medusa cart exists for this session BEFORE the turn, so a
    // cart-op the model proposes (e.g. order.item.add on a fresh session)
    // adjudicates against a real cart — the pack-orders requireCartIdForCartOps
    // guard needs payload.cartId, which BKL-028 threads only when the session cart
    // exists (cart:active:session:<sid>, the SAME key getOrCreateCart writes). This
    // is idempotent (reuses the session cart after the first turn) and mirrors the
    // web app's cart-per-session; the guard is NOT weakened. Never fatal.
    try {
      await getOrCreateCart(
        {},
        {
          channel: Channel.Web,
          sessionId,
          ...(customerId ? { customerId } : {}),
          userType: customerId ? "customer" : "guest",
        },
      );
    } catch (err) {
      server.log.warn({ err }, "[chat] cart pre-ensure failed (non-fatal)");
    }

    const inbound: ChannelMessage = {
      channel: "web",
      customerId: turnCustomerId,
      conversationId: sessionId,
      externalId: messageId,
      text: message,
      receivedAt: new Date().toISOString(),
      locale: "pt-BR",
    };

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: turnCustomerId,
      sessionKey: sessionId,
      inbound,
    });

    try {
      // ── BKL-212: confirm-resume niceties, resolved BEFORE handleTurn ───────
      // The WEB mirror of the OPS ingresses (ops-whatsapp-ingress.ts:314-390 /
      // admin/ops-chat.ts:203-285): while a confirmation is parked, two reply
      // shapes are answered by the ingress itself instead of burning a model turn
      // that re-plans them. EVERYTHING else — an explicit "sim", a mixed reply,
      // any ordinary text, or no park at all — falls through to the unchanged path
      // below. There is no freshness partition (customer parks carry no TTL — see
      // web-confirm-channel.ts), so these engage on exactly the parks the
      // WebConfirmChannel matcher itself can still resume.
      const parked = capsule.loadedSession?.pendingConfirmations;

      // A BARE soft affirmative ("ok"/"pode"/"beleza") is too weak to execute on
      // web — the matcher deliberately resolves it to null (unlike the WhatsApp
      // customer channel, which confirms on a bare "ok" by design), so today it
      // falls through to a full model turn. Restate the parked prompt and ask for
      // an explicit confirm. NOTHING is unparked and nothing executes: a follow-up
      // "sim" still resumes the park through the normal adjudicated path. A soft
      // affirmative that also carries CONTENT ("ok mas muda para 19h") is a new
      // request, not a bare yes — it stays on the normal loop.
      const softRestate = webSoftAffirmativeRestateNotice(message, parked);
      if (softRestate !== undefined) {
        turnHandled = true;
        server.log.warn(
          { event: "chat.soft_affirm_restate", sessionId, pending: parked?.length ?? 0 },
          "[chat] soft affirmative on a parked confirmation — restating, awaiting an explicit confirm, skipping the turn",
        );
        await deliverIngressReply({
          server,
          sessionId,
          text: softRestate,
          customerId,
          isAuthenticated,
          aborted: turnAbort.signal.aborted,
        });
        return;
      }

      // A PURE negative declines the park at the ingress: unpark + acknowledge and
      // SKIP the turn, so the negative text never reaches the planner (claustrum's
      // own deny path unparks and THEN re-plans the "no" as a fresh command — the
      // BKL-191 re-prompt). Unparking BEFORE handleTurn is the ops precedent.
      // Fail-honest: an unpark failure falls through to the normal loop rather
      // than acknowledging a cancellation that did not stick.
      const declineTarget = webNegativeDeclineTarget(message, parked);
      if (declineTarget !== undefined) {
        let unparked = false;
        try {
          await capsule.session.unpark(
            capsule.loadedSession.id,
            declineTarget.envelope.intentHash,
          );
          unparked = true;
        } catch (err) {
          server.log.warn(
            err,
            "[chat] negative-decline unpark failed — falling through to the normal loop (BKL-212)",
          );
        }
        if (unparked) {
          turnHandled = true;
          server.log.warn(
            {
              event: "chat.negative_declined_park",
              sessionId,
              kind: String(declineTarget.envelope.kind),
            },
            "[chat] negative reply on a parked confirmation — declined + unparked, skipping the turn (BKL-212)",
          );
          await deliverIngressReply({
            server,
            sessionId,
            text: WEB_NEGATIVE_DECLINE_ACK_PTBR,
            customerId,
            isAuthenticated,
            aborted: turnAbort.signal.aborted,
          });
          return;
        }
      }

      const turn = await beginWireTurn(() => handleTurn(capsule, inbound));
      // The conductor produced a result — the inner classify below now owns the
      // no-delivery decision, so a later (post-result) throw must not re-open in
      // the catch (F2 gate).
      turnHandled = true;

      // Client disconnected mid-turn — we must NOT deliver/persist a reply nobody
      // is listening for.
      const aborted = turnAbort.signal.aborted;

      // #6 — `turnAbort.signal.aborted` is set by BOTH:
      //   (a) a genuine SSE client-disconnect (tab close / backgrounding via
      //       abortTurnOnDisconnect), and
      //   (b) a NEWER turn superseding this one (`previous?.abort()` in POST).
      // NEITHER is a customer-facing delivery failure: in (a) the customer LEFT
      // (routine user behavior — nobody is waiting), and in (b) a successor now
      // owns the slot and WILL answer. A web SSE turn has no wall-clock deadline,
      // so every abort is one of these two → suppress like a bot-pause
      // (`suppressed_paused → null`), never opening a false timeout incident +
      // staff ping (that noise storm was the old over-eager P0-2 web analog).
      const disposition: TurnDisposition = aborted
        ? "suppressed_paused"
        : webDisposition(turn.response.text);
      const decisionKind = turn.decision?.kind;
      let deliveredText = false;

      // Streaming Option A: a single assembled text chunk. Only delivered when
      // the client is still listening (not aborted).
      if (!aborted && disposition === "deliverable") {
        // EGRESS BRAND (E-1): legacy prose responder text → branded via the
        // transitional minter (W5 binds the claims pipeline value directly).
        pushChunk(sessionId, {
          type: "text_delta",
          delta: wrapLegacyResponderText(turn.response.text),
        });

        // Persist the assistant reply on dev's Redis session store AFTER
        // the turn (SessionPort.save is a stub — see the user-message note).
        await appendMessages(
          sessionId,
          [{ role: "assistant", content: turn.response.text }],
          isAuthenticated,
          { customerId, channel: "web" },
        );
        deliveredText = true;
      }

      // Auto-close (M4): a successfully-delivered web reply self-heals an OPEN
      // incident on this session → AUTO_RESOLVED, matching the WhatsApp seam
      // (whatsapp-webhook.ts:1009). Gated on the SAME delivered predicate (web has
      // no PIX side-channel, so `deliveredText` already implies a trimmed non-blank
      // reply). Detached fire-and-forget (fail-open + idempotent) so it never gates
      // the SSE turn.
      if (deliveredText && capsule.turnId) {
        void closeIncidentOnDeliveredReply(sessionId, capsule.turnId, server.log).catch(() => {});
      }

      // Classify on BOTH the normal and abort paths (pause is already excluded —
      // it returned before openCapsule). `deliveredText` keys the genuine-drop
      // decision on what actually reached the customer, so an aborted-with-text
      // turn maps to `timeout` (P0-2 web analog) and a deliverable+delivered
      // turn short-circuits to no incident.
      const classification = classifyTurnDelivery({
        disposition,
        ...(decisionKind !== undefined ? { decisionKind } : {}),
        deliveredText,
      });

      if (classification) {
        await openWebDrop({
          sessionId,
          messageId,
          customerId,
          turnId: capsule.turnId,
          decisionKind,
          classification,
          log: server.log,
        });

        // Customer-facing fallback — STRICTLY AFTER classify+emit+open so a
        // substitution can never mask incident emission. Only when the client
        // is still listening (not aborted) and only for an empty/whitespace
        // completion (never the aborted-timeout path). Flag-gated, consistent
        // with the WhatsApp WA_EMPTY_COMPLETION_HOLDING harm-reducer.
        if (
          !aborted &&
          isWebEmptyHoldingEnabled() &&
          (disposition === "empty_completion" || disposition === "whitespace_only")
        ) {
          pushChunk(sessionId, {
            type: "text_delta",
            delta: mintFallbackReply(WEB_HOLDING_MESSAGE_PTBR),
          });
        }
      }

      // Terminal — only when the client is still listening.
      if (!aborted) pushChunk(sessionId, { type: "done" });
    } finally {
      await conductor.closeCapsule(capsule);
    }
  } catch (err) {
    server.log.error(err, "[chat] Conductor turn failed");
    const aborted = turnAbort.signal.aborted;

    // BKL-168 — the LAST-RESORT never-silent backstop. A throw that escaped
    // handleTurn before ANY conductor result reached the customer (`!turnHandled`),
    // with the client STILL connected (`!aborted`), means the customer is OWED a
    // reply and got nothing. Open a governed incident (the no-reply plane must SEE
    // this class — the `turn_error` escape was previously incident-less) AND deliver
    // an honest deterministic pt-BR fallback frame — NEVER the bare {type:error}.
    //   - `!turnHandled` ⇒ the throw preceded delivery (the inner classify never
    //     ran). A POST-result throw (e.g. closeCapsule/appendMessages AFTER delivery)
    //     is already owned by the inner path — never double-open or re-deliver.
    //   - `!aborted` ⇒ #6: a client-disconnect / superseding newer turn is nobody
    //     waiting — never an incident nor a substituted reply.
    if (!turnHandled && !aborted) {
      // Map the escaped throw to a FROZEN incident cause: an explicit provider
      // "timed out" stays `timeout`; every other pre-send escape (the `turn_error`
      // class) opens as `send_failed` — the closest frozen "not delivered" cause, so
      // the no-reply plane records it. `customerImpacted: true` — the customer's real
      // answer never arrived (the fallback below is an honest apology, not the answer
      // asked for), mirroring the no-reply plane's empty_completion semantics.
      // openWebDrop is fail-open (never throws); the fallback is pushed STRICTLY
      // AFTER it so a substitution can never mask emission.
      const catchCause = classifyCatchError({
        aborted: false,
        message: err instanceof Error ? err.message : String(err),
        sendEntered: false,
        sendCompleted: false,
      });
      await openWebDrop({
        sessionId,
        messageId,
        customerId,
        turnId: undefined,
        decisionKind: undefined,
        classification: {
          cause: catchCause === "timeout" ? "timeout" : "send_failed",
          customerImpacted: true,
        },
        log: server.log,
      });
      // Honest deterministic pt-BR fallback (text_delta + done), branded — the
      // customer sees a real reply, never a bare {type:error} void.
      pushChunk(sessionId, {
        type: "text_delta",
        delta: mintFallbackReply(WEB_HOLDING_MESSAGE_PTBR),
      });
      pushChunk(sessionId, { type: "done" });
    } else if (!aborted) {
      // A POST-result throw (turnHandled): the inner path already served the customer
      // and owns any incident — terminate the stream honestly rather than push a bare
      // {type:error} over an already-delivered reply.
      pushChunk(sessionId, { type: "done" });
    }
  } finally {
    // Retire the registry slot only if it is still ours — a newer turn for
    // the same session may have replaced it.
    if (turnAbortControllers.get(sessionId) === turnAbort) {
      turnAbortControllers.delete(sessionId);
    }
    cleanupStream(sessionId);
    await releaseWebAgentLock(sessionId);
  }
}

// ── GET (SSE) helpers (S3776: keep the route handler's cognitive complexity low) ──

/** Write a terminal SSE error frame (event-stream headers + end). */
function writeSseError(reply: FastifyReply, message: string): void {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.flushHeaders();
  reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
  reply.raw.end();
}

/**
 * Verify the SSE consumer may read this session's stream (authenticated owner,
 * or guest with a matching secret). Returns true if access was denied (an error
 * frame was written + the response ended) and the caller must stop. Fails closed
 * on a Redis error (503).
 */
async function denyStreamAccess(
  server: FastifyInstance,
  sessionId: string,
  customerId: string | undefined,
  providedSecret: string | undefined,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    if (customerId) {
      // Authenticated stream: must own the session.
      const owner = await redis.get(rk(`session:owner:${sessionId}`));
      if (owner && customerId !== owner) {
        writeSseError(reply, "Acesso negado.");
        return true;
      }
    } else {
      // Guest stream (P2-SEC-SSECORS): when a guest secret EXISTS for this
      // session (minted by POST /api/chat/messages), require x-session-secret
      // to match it — otherwise any guest could read another guest's stream
      // by knowing the sessionId. When NO secret exists, this is either a
      // non-existent/unowned stream or an authless dev session: do NOT reject
      // here — fall through to the getStream/replay/404 path below, which
      // returns "Sessão não encontrada" (preserving dev's GET contract).
      const expectedSecret = await redis.get(rk(`session:secret:${sessionId}`));
      if (expectedSecret && providedSecret !== expectedSecret) {
        writeSseError(reply, "Acesso negado.");
        return true;
      }
    }
    return false;
  } catch (err) {
    server.log.warn({ sessionId, err }, "Redis session ownership check failed — failing closed");
    reply.raw.writeHead(503, { "Content-Type": "text/event-stream" });
    reply.raw.write(
      `data: ${JSON.stringify({ type: "error", message: "Erro temporario. Tente novamente." })}\n\n`,
    );
    reply.raw.end();
    return true;
  }
}

/**
 * Same-replica fast path: if the producer ran on THIS replica, replay the
 * buffered chunks and stream live ones off the in-memory emitter. Returns true
 * if it handled the request (an entry existed).
 */
function serveFromLocalStream(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  stopHeartbeat: () => void,
  abortTurnOnDisconnect: () => void,
): boolean {
  const entry = getStream(sessionId);
  if (!entry) return false;

  // True once this consumer delivered the terminal chunk — a close event
  // after that is normal socket teardown, never an early disconnect.
  let terminated = false;

  // Replay buffered chunks for late clients
  for (const chunk of entry.buffer) {
    reply.raw.write(`data: ${JSON.stringify(chunkToWire(chunk))}\n\n`);
    if (chunk.type === "done" || chunk.type === "error") {
      stopHeartbeat();
      reply.raw.end();
      return true;
    }
  }

  // Listen for new chunks
  const onChunk = (chunk: unknown): void => {
    reply.raw.write(`data: ${JSON.stringify(chunkToWire(chunk as StreamChunk))}\n\n`);
    const c = chunk as { type: string };
    if (c.type === "done" || c.type === "error") {
      terminated = true;
      entry.emitter.off("chunk", onChunk);
      stopHeartbeat();
      reply.raw.end();
    }
  };

  entry.emitter.on("chunk", onChunk);

  // Clean up listener + abort the producing turn ONLY if the client
  // disconnected before the stream terminated (see abortTurnOnDisconnect).
  request.raw.on("close", () => {
    entry.emitter.off("chunk", onChunk);
    if (!terminated) abortTurnOnDisconnect();
  });
  return true;
}

/**
 * Cross-replica path: the producer ran on a *different* replica, so there is no
 * local entry. Stream via Redis Pub/Sub + replay list, polling briefly (2s) for
 * the producer to publish its first chunk.
 */
async function serveFromRedis(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  stopHeartbeat: () => void,
  abortTurnOnDisconnect: () => void,
): Promise<void> {
  let subscription: Awaited<ReturnType<typeof subscribeToStream>>;
  let ended = false;

  const writeChunk = (chunk: StreamChunk): void => {
    if (ended) return;
    reply.raw.write(`data: ${JSON.stringify(chunkToWire(chunk))}\n\n`);
    if (chunk.type === "done" || chunk.type === "error") {
      ended = true;
      stopHeartbeat();
      void subscription?.close();
      reply.raw.end();
    }
  };

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !subscription) {
    subscription = await subscribeToStream(sessionId, writeChunk);
    if (subscription) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!subscription) {
    stopHeartbeat();
    reply.raw.write(
      `data: ${JSON.stringify({ type: "error", message: "Sessão não encontrada." })}\n\n`,
    );
    reply.raw.end();
    return;
  }

  // The whole stream (incl. a terminal done/error) can be delivered
  // synchronously from the replay list *inside* subscribeToStream, before
  // `subscription` was assignable — in which case writeChunk's close() ran
  // as a no-op. Close now so we never leak the duplicated subscriber.
  if (ended) {
    stopHeartbeat();
    void subscription.close();
    return;
  }

  // Otherwise release the duplicated Redis subscriber if the client
  // disconnects before the stream terminates. Abort only on an EARLY
  // disconnect — a post-terminal close is normal socket teardown (see
  // abortTurnOnDisconnect).
  request.raw.on("close", () => {
    if (ended) return;
    abortTurnOnDisconnect();
    ended = true;
    void subscription?.close();
  });
}

export async function chatRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── POST /api/chat/messages ────────────────────────────────────────────────

  app.post(
    "/api/chat/messages",
    {
      schema: {
        tags: ["chat"],
        summary: "Enviar mensagem ao agente",
        body: PostMessageBody,
        response: { 200: PostMessageResponse },
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      const { sessionId, message } = request.body;

      const redis = await getRedisClient();

      // ── Session ownership verification (zero-trust) ──────────────────────
      if (request.customerId) {
        const tokenHeader = request.headers["x-session-token"] as string | undefined;
        const rejected = await rejectOnOwnershipFailure(
          redis,
          sessionId,
          request.customerId,
          tokenHeader,
          reply,
        );
        if (rejected) return reply;
      }

      // ── SEC: Guest session secret (prevents session hijacking) ─────────────
      let sessionSecret: string | undefined;
      if (!request.customerId) {
        const providedSecret = request.headers["x-session-secret"] as string | undefined;
        const guest = await resolveGuestSecret(redis, sessionId, providedSecret, reply);
        if (guest.rejected) return reply;
        sessionSecret = guest.secret;
      }

      // Track session activity for idle rotation
      await redis.set(rk(`session:lastActivity:${sessionId}`), new Date().toISOString(), { EX: 86400 });

      // Distributed lock — prevents concurrent agent runs per session
      const lockAcquired = await acquireWebAgentLock(sessionId);
      if (!lockAcquired) {
        void (reply as unknown as { status(code: number): typeof reply }).status(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "Aguarde a resposta anterior.",
        } as never);
        return reply;
      }

      const messageId = uuidv4();
      const isAuthenticated = Boolean(request.customerId);

      // Load conversation history on dev's Redis session store BEFORE the turn.
      // The claustrum SessionPort (redisSessionStore.save/load) is a TODO stub,
      // so history persistence stays on dev's store; the conductor loads its own
      // memory snapshot. We load here to preserve dev's "history loaded before
      // running agent" contract (and to keep the store warm for the GET replay).
      await loadSession(sessionId);

      // Persist the user message on dev's Redis session store BEFORE the turn.
      await appendMessages(sessionId, [{ role: "user", content: message }], isAuthenticated, {
        customerId: request.customerId,
        channel: "web",
      });

      createStream(sessionId);

      const sessionToken = request.customerId
        ? createSessionToken(sessionId, request.customerId)
        : undefined;

      // Abort controller for this turn (P2-CONC-ABORT). Registered by sessionId
      // so the SSE GET's "close" handler can cancel it when the client goes away;
      // its `signal` gates the post-turn delivery below so a turn that resolves
      // after the consumer disconnected does not push chunks. We do NOT thread it
      // into handleTurn (the Capsule does not accept an external signal), so this
      // bounds the *delivery* side only.
      const turnAbort = new AbortController();
      const previous = turnAbortControllers.get(sessionId);
      previous?.abort();
      turnAbortControllers.set(sessionId, turnAbort);

      // ── Delegate to the claustrum Conductor (fire-and-forget) ──────────────
      void runConductorTurn({
        server,
        sessionId,
        message,
        messageId,
        customerId: request.customerId,
        isAuthenticated,
        turnAbort,
      });

      return reply.send({
        messageId,
        ...(sessionToken && { sessionToken }),
        ...(sessionSecret && { sessionSecret }),
      });
    },
  );

  // ── GET /api/chat/stream/:sessionId ───────────────────────────────────────

  app.get(
    "/api/chat/stream/:sessionId",
    {
      schema: {
        tags: ["chat"],
        summary: "Stream SSE de resposta do agente",
        params: StreamParams,
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      const { sessionId } = request.params;

      // Hijack the reply so Fastify doesn't interfere with our raw SSE writes
      reply.hijack();

      // CORS for the hijacked SSE response (P2-SEC-SSECORS). The global
      // @fastify/cors plugin does not run on a hijacked reply, so we set the
      // headers ourselves — but ONLY for an Origin on the configured allowlist.
      // Reflecting an arbitrary Origin together with Allow-Credentials would let
      // any website read an authenticated/guest stream cross-origin.
      const origin = request.headers.origin;
      if (origin && isOriginAllowed(origin)) {
        reply.raw.setHeader("Access-Control-Allow-Origin", origin);
        reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
        reply.raw.setHeader("Vary", "Origin");
      }

      // Verify session ownership / guest-secret before allowing the connection.
      const providedSecret = request.headers["x-session-secret"] as string | undefined;
      if (await denyStreamAccess(server, sessionId, request.customerId, providedSecret, reply)) {
        return;
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
      reply.raw.flushHeaders();

      // P2-MEM-SSEHEARTBEAT: proactive keep-alive so a half-open socket (which
      // never fires "close") cannot leak this response and its emitter/Redis
      // subscriber forever. Idempotent stop; ALWAYS cleared on any termination
      // path (terminal chunk, error, client close) so the interval never leaks.
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const stopHeartbeat = (): void => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };
      const heartbeatMs = resolveSseHeartbeatMs();
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          // A comment line is ignored by EventSource but keeps the socket warm;
          // a write to a dead half-open peer surfaces as an error → stop+cleanup.
          try {
            reply.raw.write(`: ping\n\n`);
          } catch {
            stopHeartbeat();
          }
        }, heartbeatMs);
        // Don't let a lone heartbeat timer keep the process alive at shutdown.
        heartbeat.unref?.();
      }

      // P2-CONC-ABORT: when this SSE consumer disconnects, signal the producing
      // turn (if it ran on THIS replica) so it stops delivering after the client
      // is gone. Same-replica only — see turnAbortControllers above.
      //
      // T1a-13 fix — only abort while the stream is UNFINISHED. The socket
      // "close" for a COMPLETED stream can fire late (keep-alive pooling delays
      // socket teardown well past reply.raw.end()), by which time the registry
      // slot may already belong to the session's NEXT turn — the late close was
      // aborting that innocent turn, whose `done` then never got pushed and the
      // client hung to its timeout (surfaced by the first JOURNEY-001 live run;
      // any user sending a quick follow-up message could lose the reply the
      // same way). A disconnect is only meaningful BEFORE the terminal chunk.
      const abortTurnOnDisconnect = (): void => {
        turnAbortControllers.get(sessionId)?.abort();
      };

      // Safety net: whatever path ends this request, the heartbeat is stopped.
      request.raw.on("close", stopHeartbeat);

      // Same-replica fast path: if the producer ran on THIS replica, the
      // in-memory entry exists and we serve directly off its EventEmitter.
      if (serveFromLocalStream(request, reply, sessionId, stopHeartbeat, abortTurnOnDisconnect)) {
        return;
      }

      // Cross-replica path: the producer ran on a *different* replica, so there
      // is no local entry. Stream via Redis Pub/Sub + replay list, polling
      // briefly (2s) for the producer to publish its first chunk — same grace
      // the in-memory bridge previously gave a GET that raced the POST.
      await serveFromRedis(request, reply, sessionId, stopHeartbeat, abortTurnOnDisconnect);
    },
  );
}
