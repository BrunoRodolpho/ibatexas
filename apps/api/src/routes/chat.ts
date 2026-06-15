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
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { handleTurn, type ChannelMessage } from "@claustrum/core";
import { Channel, type StreamChunk } from "@ibatexas/types";
import { getRedisClient, rk, createSessionToken, verifySessionToken } from "@ibatexas/tools";
import { loadSession, appendMessages } from "../session/store.js";
import { optionalAuth } from "../middleware/auth.js";
import {
  createStream,
  pushChunk,
  getStream,
  subscribeToStream,
  cleanupStream,
} from "../streaming/emitter.js";
import { acquireWebAgentLock, releaseWebAgentLock } from "../streaming/execution-queue.js";
import { getConductor } from "../claustrum-bootstrap.js";
import { isSessionPausedForHuman } from "../escalation/escalation-store.js";

const PostMessageBody = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  channel: z.nativeEnum(Channel),
});

const PostMessageResponse = z.object({
  messageId: z.string().uuid(),
  sessionToken: z.string().optional(),
  sessionSecret: z.string().optional(),
});

const StreamParams = z.object({
  sessionId: z.string().uuid(),
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

      // ── Session ownership verification (zero-trust) ──────────────────────
      const redis = await getRedisClient();
      const ownerKey = rk(`session:owner:${sessionId}`);

      if (request.customerId) {
        const existingOwner = await redis.get(ownerKey);

        const tokenHeader = request.headers["x-session-token"] as string | undefined;
        if (tokenHeader) {
          const claim = verifySessionToken(tokenHeader);
          if (!claim || claim.sessionId !== sessionId || claim.customerId !== request.customerId) {
            void (reply as unknown as { status(code: number): typeof reply }).status(403).send({
              statusCode: 403,
              error: "Forbidden",
              message: "Token de sessão inválido.",
            } as never);
            return reply;
          }
        }

        if (existingOwner && existingOwner !== request.customerId) {
          void (reply as unknown as { status(code: number): typeof reply }).status(403).send({
            statusCode: 403,
            error: "Forbidden",
            message: "Sessão pertence a outro usuário.",
          } as never);
          return reply;
        }

        await redis.set(ownerKey, request.customerId, { EX: 86400 });
      }

      // ── SEC: Guest session secret (prevents session hijacking) ─────────────
      let sessionSecret: string | undefined;
      if (!request.customerId) {
        const secretKey = rk(`session:secret:${sessionId}`);
        const existingSecret = await redis.get(secretKey);
        const providedSecret = request.headers["x-session-secret"] as string | undefined;

        if (existingSecret) {
          // Subsequent request — verify secret
          if (providedSecret !== existingSecret) {
            void (reply as unknown as { status(code: number): typeof reply }).status(403).send({
              statusCode: 403,
              error: "Forbidden",
              message: "Segredo de sessão inválido.",
            } as never);
            return reply;
          }
        } else {
          // First request — generate and store secret
          sessionSecret = crypto.randomUUID();
          await redis.set(secretKey, sessionSecret, { EX: 3600 });
        }
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
      void (async () => {
        try {
          // D2 bot-pause gate: once a human takes over this session (an open
          // escalation), the LLM must stop auto-replying. The user's inbound was
          // already archived above (appendMessages(user)), so staff still see it;
          // we just suppress the bot turn. Fail-open (a Redis hiccup keeps the
          // bot replying — see isSessionPausedForHuman).
          if (await isSessionPausedForHuman(sessionId)) {
            pushChunk(sessionId, { type: "done" });
            return;
          }

          const conductor = getConductor();
          const customerId = request.customerId ?? `guest:${sessionId}`;

          const inbound: ChannelMessage = {
            channel: "web",
            customerId,
            conversationId: sessionId,
            externalId: messageId,
            text: message,
            receivedAt: new Date().toISOString(),
            locale: "pt-BR",
          };

          const capsule = await conductor.openCapsule({
            channel: "web",
            customerId,
            sessionKey: sessionId,
            inbound,
          });

          try {
            const turn = await handleTurn(capsule, inbound);

            // Client disconnected mid-turn — skip delivery + persistence of a
            // reply nobody is listening for.
            if (turnAbort.signal.aborted) return;

            // Streaming Option A: a single assembled text chunk + terminal done.
            if (turn.response.text) {
              pushChunk(sessionId, { type: "text_delta", delta: turn.response.text });

              // Persist the assistant reply on dev's Redis session store AFTER
              // the turn (SessionPort.save is a stub — see the user-message note).
              await appendMessages(
                sessionId,
                [{ role: "assistant", content: turn.response.text }],
                isAuthenticated,
                { customerId: request.customerId, channel: "web" },
              );
            }
            pushChunk(sessionId, { type: "done" });
          } finally {
            await conductor.closeCapsule(capsule);
          }
        } catch (err) {
          server.log.error(err, "[chat] Conductor turn failed");
          if (!turnAbort.signal.aborted) {
            pushChunk(sessionId, { type: "error", message: "Erro interno." });
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
      })();

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
      try {
        const redis = await getRedisClient();
        if (request.customerId) {
          // Authenticated stream: must own the session.
          const owner = await redis.get(rk(`session:owner:${sessionId}`));
          if (owner && request.customerId !== owner) {
            reply.raw.setHeader("Content-Type", "text/event-stream");
            reply.raw.flushHeaders();
            reply.raw.write(
              `data: ${JSON.stringify({ type: "error", message: "Acesso negado." })}\n\n`,
            );
            reply.raw.end();
            return;
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
          const providedSecret = request.headers["x-session-secret"] as string | undefined;
          if (expectedSecret && providedSecret !== expectedSecret) {
            reply.raw.setHeader("Content-Type", "text/event-stream");
            reply.raw.flushHeaders();
            reply.raw.write(
              `data: ${JSON.stringify({ type: "error", message: "Acesso negado." })}\n\n`,
            );
            reply.raw.end();
            return;
          }
        }
      } catch (err) {
        server.log.warn({ sessionId, err }, "Redis session ownership check failed — failing closed");
        reply.raw.writeHead(503, { "Content-Type": "text/event-stream" });
        reply.raw.write(
          `data: ${JSON.stringify({ type: "error", message: "Erro temporario. Tente novamente." })}\n\n`,
        );
        reply.raw.end();
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
      const entry = getStream(sessionId);
      if (entry) {
        // True once this consumer delivered the terminal chunk — a close event
        // after that is normal socket teardown, never an early disconnect.
        let terminated = false;

        // Replay buffered chunks for late clients
        for (const chunk of entry.buffer) {
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (chunk.type === "done" || chunk.type === "error") {
            stopHeartbeat();
            reply.raw.end();
            return;
          }
        }

        // Listen for new chunks
        const onChunk = (chunk: unknown): void => {
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
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
        return;
      }

      // Cross-replica path: the producer ran on a *different* replica, so there
      // is no local entry. Stream via Redis Pub/Sub + replay list, polling
      // briefly (2s) for the producer to publish its first chunk — same grace
      // the in-memory bridge previously gave a GET that raced the POST.
      let subscription: Awaited<ReturnType<typeof subscribeToStream>>;
      let ended = false;

      const writeChunk = (chunk: StreamChunk): void => {
        if (ended) return;
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
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
    },
  );
}
