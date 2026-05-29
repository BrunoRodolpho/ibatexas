// Chat routes — thin delegate over the @claustrum/* Conductor.
//
// Was 291 LOC of orchestrator + session ownership + SSE plumbing; the
// claustrum cutover collapses the orchestration into
//   conductor.openCapsule -> handleTurn -> conductor.closeCapsule
// and pushes the SSE delivery responsibility into the WebChannel's sink
// callback so the route stays a transport-only adapter.
//
// Endpoints (unchanged):
//   POST /api/chat/messages
//   GET  /api/chat/stream/:sessionId
//
// What this file MUST do (unchanged from the kernel-always-on cutover):
//   - Verify session ownership via the existing redis `session:owner:*` keys
//   - Issue session tokens for authenticated clients (createSessionToken)
//   - Issue session secrets for guests (UUID, 1h TTL)
//   - Distributed lock per session to prevent concurrent agent runs
//   - SSE buffer replay for late clients
//
// What this file delegates to claustrum:
//   - Tenant resolution, planner, responder, adjudication, telemetry — all
//     via `conductor.openCapsule({ channel: "web", customerId, ... })`.
//   - LLM call + tool execution — `handleTurn(capsule, channelMessage)`.

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { handleTurn, type ChannelMessage } from "@claustrum/core";
import { Channel, type StreamChunk } from "@ibatexas/types";
import { getRedisClient, rk, createSessionToken, verifySessionToken } from "@ibatexas/tools";
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

// ── CORS allowlist for the SSE endpoint (P2-SEC-SSECORS) ──────────────────────
// The SSE GET is `reply.hijack()`-ed, so the global @fastify/cors plugin (which
// only sets ACAO on non-hijacked replies) never runs for it. We must therefore
// reproduce the SAME allowlist here rather than reflecting an arbitrary Origin
// with Allow-Credentials (which would let any site read an authenticated stream).
//
// This MIRRORS `resolveOrigin()` in ../plugins/cors.ts — kept env-identical
// (CORS_ORIGIN → NODE_ENV dev LAN regexes → WEB_URL) so the two cannot diverge.
// (Inlined rather than imported because that helper is not currently exported;
// see the route below and the audit note.)
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

// ── Per-session turn abort registry (P2-CONC-ABORT) ───────────────────────────
// The producer (POST) fires the agent turn fire-and-forget; the SSE consumer
// (GET) is a *separate* request. When the consumer disconnects we want to stop
// wasting work and, crucially, avoid letting the turn deliver/observe side
// effects after the client is gone. We key an AbortController by sessionId so
// the GET's "close" handler can signal the POST's in-flight turn.
//
// NOTE: producer and consumer may land on DIFFERENT replicas (see emitter.ts).
// This registry is in-process, so it only propagates disconnects on the
// same-replica fast path — the common single-replica case. Cross-replica abort
// would need a Redis signal and is intentionally out of scope for this fix.
const turnAbortControllers = new Map<string, AbortController>();

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

export async function chatRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

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
      const ownerKey = rk(`session:owner:${sessionId}`);

      // Session ownership + token verification (unchanged from pre-cutover).
      // Zod's typed response narrows `reply.send` to the 200 schema; for
      // error responses we bypass via `status()` cast (legacy pattern).
      const errReply = (code: number, payload: unknown): typeof reply => {
        void (reply as unknown as { status(c: number): typeof reply })
          .status(code)
          .send(payload as never);
        return reply;
      };

      if (request.customerId) {
        const existingOwner = await redis.get(ownerKey);

        const tokenHeader = request.headers["x-session-token"] as string | undefined;
        if (tokenHeader) {
          const claim = verifySessionToken(tokenHeader);
          if (!claim || claim.sessionId !== sessionId || claim.customerId !== request.customerId) {
            return errReply(403, {
              statusCode: 403,
              error: "Forbidden",
              message: "Token de sessão inválido.",
            });
          }
        }

        if (existingOwner && existingOwner !== request.customerId) {
          return errReply(403, {
            statusCode: 403,
            error: "Forbidden",
            message: "Sessão pertence a outro usuário.",
          });
        }

        await redis.set(ownerKey, request.customerId, { EX: 86400 });
      }

      // Guest session secret (unchanged).
      let sessionSecret: string | undefined;
      if (!request.customerId) {
        const secretKey = rk(`session:secret:${sessionId}`);
        const existingSecret = await redis.get(secretKey);
        const providedSecret = request.headers["x-session-secret"] as string | undefined;
        if (existingSecret) {
          if (providedSecret !== existingSecret) {
            return errReply(403, {
              statusCode: 403,
              error: "Forbidden",
              message: "Segredo de sessão inválido.",
            });
          }
        } else {
          sessionSecret = crypto.randomUUID();
          await redis.set(secretKey, sessionSecret, { EX: 3600 });
        }
      }

      await redis.set(rk(`session:lastActivity:${sessionId}`), new Date().toISOString(), { EX: 86400 });

      const lockAcquired = await acquireWebAgentLock(sessionId);
      if (!lockAcquired) {
        return errReply(409, {
          statusCode: 409,
          error: "Conflict",
          message: "Aguarde a resposta anterior.",
        });
      }

      const messageId = uuidv4();
      createStream(sessionId);

      const sessionToken = request.customerId
        ? createSessionToken(sessionId, request.customerId)
        : undefined;

      // Abort controller for this turn (P2-CONC-ABORT). Registered by sessionId
      // so the SSE GET's "close" handler can cancel it when the client goes away;
      // its `signal` gates the post-turn side effects below so a turn that
      // resolves after the consumer disconnected does not push chunks. We do NOT
      // thread it into handleTurn — the conductor cutover is inert/deferred and
      // its wiring must not be touched — so this bounds the *delivery* side.
      const turnAbort = new AbortController();
      const previous = turnAbortControllers.get(sessionId);
      previous?.abort();
      turnAbortControllers.set(sessionId, turnAbort);

      // ── Delegate to claustrum Conductor ───────────────────────────────────
      void (async () => {
        try {
          const conductor = getConductor();
          const customerId = request.customerId ?? `guest:${sessionId}`;

          const inbound: ChannelMessage = {
            channel: "web",
            customerId,
            conversationId: sessionId,
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

            // Client disconnected mid-turn — skip delivery. The buffer/replay is
            // gone with the consumer, and pushing now would only resurrect a
            // dead stream entry.
            if (turnAbort.signal.aborted) return;

            // Stream the assembled text to the SSE consumer in one chunk
            // for now; per-token streaming is a follow-up that wires the
            // WebChannel.sink into the conductor's openCapsule().
            if (turn.response.text) {
              pushChunk(sessionId, { type: "text_delta", delta: turn.response.text });
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
          // Only retire the registry slot if it is still ours — a newer turn for
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

  // ── SSE stream (unchanged transport, unchanged buffer-replay semantics) ─
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

      try {
        const redis = await getRedisClient();
        if (request.customerId) {
          // Authenticated stream: must own the session.
          const owner = await redis.get(rk(`session:owner:${sessionId}`));
          if (owner && request.customerId !== owner) {
            reply.raw.setHeader("Content-Type", "text/event-stream");
            reply.raw.flushHeaders();
            reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Acesso negado." })}\n\n`);
            reply.raw.end();
            return;
          }
        } else {
          // Guest stream (P2-SEC-SSECORS): verify x-session-secret against the
          // stored secret minted by POST /api/chat/messages, mirroring that
          // endpoint's check. Without this any guest could read another guest's
          // stream by guessing/knowing the sessionId. Fail closed: a missing
          // stored secret means there is no legitimate guest stream to read.
          const expectedSecret = await redis.get(rk(`session:secret:${sessionId}`));
          const providedSecret = request.headers["x-session-secret"] as string | undefined;
          if (!expectedSecret || providedSecret !== expectedSecret) {
            reply.raw.setHeader("Content-Type", "text/event-stream");
            reply.raw.flushHeaders();
            reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Acesso negado." })}\n\n`);
            reply.raw.end();
            return;
          }
        }
      } catch (err) {
        server.log.warn({ sessionId, err }, "Redis session ownership check failed — failing closed");
        reply.raw.writeHead(503, { "Content-Type": "text/event-stream" });
        reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Erro temporario. Tente novamente." })}\n\n`);
        reply.raw.end();
        return;
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      // P2-CONC-ABORT: when this SSE consumer disconnects, signal the producing
      // turn (if it ran on THIS replica) so it stops delivering after the client
      // is gone. Same-replica only — see turnAbortControllers above.
      const abortTurnOnDisconnect = (): void => {
        turnAbortControllers.get(sessionId)?.abort();
      };

      // Same-replica fast path: if the producer ran on THIS replica, the
      // in-memory entry exists and we serve directly off its EventEmitter.
      const entry = getStream(sessionId);
      if (entry) {
        for (const chunk of entry.buffer) {
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (chunk.type === "done" || chunk.type === "error") {
            reply.raw.end();
            return;
          }
        }

        const onChunk = (chunk: unknown): void => {
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          const c = chunk as { type: string };
          if (c.type === "done" || c.type === "error") {
            entry.emitter.off("chunk", onChunk);
            reply.raw.end();
          }
        };

        entry.emitter.on("chunk", onChunk);
        request.raw.on("close", () => {
          entry.emitter.off("chunk", onChunk);
          abortTurnOnDisconnect();
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
        reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Sessão não encontrada." })}\n\n`);
        reply.raw.end();
        return;
      }

      // The whole stream (incl. a terminal done/error) can be delivered
      // synchronously from the replay list *inside* subscribeToStream, before
      // `subscription` was assignable — in which case writeChunk's close() ran
      // as a no-op. Close now so we never leak the duplicated subscriber.
      if (ended) {
        void subscription.close();
        return;
      }

      // Otherwise release the duplicated Redis subscriber if the client
      // disconnects before the stream terminates.
      request.raw.on("close", () => {
        abortTurnOnDisconnect();
        if (ended) return;
        ended = true;
        void subscription?.close();
      });
    },
  );
}
