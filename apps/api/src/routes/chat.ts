// Chat routes
//
// POST /api/chat/messages — accept a user message, start agent, return messageId
// GET  /api/chat/stream/:sessionId — SSE stream of agent response chunks

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { Channel, type AgentContext } from "@ibatexas/types";
import { runOrchestrator } from "@adjudicate/intent-runtime";
import { getRedisClient, rk, createSessionToken, verifySessionToken } from "@ibatexas/tools";
import { loadSession, appendMessages } from "../session/store.js";
import { optionalAuth } from "../middleware/auth.js";
import {
  createStream,
  pushChunk,
  getStream,
  cleanupStream,
} from "../streaming/emitter.js";
import { acquireWebAgentLock, releaseWebAgentLock } from "../streaming/execution-queue.js";

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

/** Poll up to maxMs for a stream entry to appear (handles brief race between POST and GET). */
async function waitForStream(
  sessionId: string,
  maxMs = 2000,
  intervalMs = 100,
): Promise<ReturnType<typeof getStream>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const entry = getStream(sessionId);
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
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
      const { sessionId, message, channel } = request.body;

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
              message: "Invalid session secret",
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

      const history = await loadSession(sessionId);
      const messageId = uuidv4();

      await appendMessages(sessionId, [{ role: "user", content: message }], Boolean(request.customerId), {
        customerId: request.customerId,
        channel: "web",
      });

      createStream(sessionId);

      const sessionToken = request.customerId
        ? createSessionToken(sessionId, request.customerId)
        : undefined;

      const context: AgentContext = {
        channel,
        sessionId,
        customerId: request.customerId,
        userType: request.userType ?? "guest",
      };

      // Fire-and-forget agent loop
      void (async () => {
        const replyParts: string[] = [];
        try {
          for await (const chunk of runOrchestrator(message, history, context)) {
            pushChunk(sessionId, chunk);
            if (chunk.type === "text_delta") {
              replyParts.push(chunk.delta);
            }
          }
          if (replyParts.length > 0) {
            await appendMessages(sessionId, [
              { role: "assistant", content: replyParts.join("") },
            ], Boolean(request.customerId), {
              customerId: request.customerId,
              channel: "web",
            });
          }
          pushChunk(sessionId, { type: "done" });
        } catch (err) {
          server.log.error(err, "[chat] Agent error");
          pushChunk(sessionId, { type: "error", message: "Erro interno." });
        } finally {
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

      // CORS headers must be set manually because reply.raw bypasses @fastify/cors
      const origin = request.headers.origin;
      if (origin) {
        reply.raw.setHeader("Access-Control-Allow-Origin", origin);
        reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      }

      // Verify session ownership before allowing SSE connection
      try {
        const redis = await getRedisClient();
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

      const entry = await waitForStream(sessionId);

      if (!entry) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: "error", message: "Sessão não encontrada." })}\n\n`,
        );
        reply.raw.end();
        return;
      }

      // Replay buffered chunks for late clients
      for (const chunk of entry.buffer) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.type === "done" || chunk.type === "error") {
          reply.raw.end();
          return;
        }
      }

      // Listen for new chunks
      const onChunk = (chunk: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        const c = chunk as { type: string };
        if (c.type === "done" || c.type === "error") {
          entry.emitter.off("chunk", onChunk);
          reply.raw.end();
        }
      };

      entry.emitter.on("chunk", onChunk);

      // Clean up listener if client disconnects early
      request.raw.on("close", () => {
        entry.emitter.off("chunk", onChunk);
      });
    },
  );
}
