// Chat routes
//
// POST /api/chat/messages — accept a user message, start agent, return messageId
// GET  /api/chat/stream/:sessionId — SSE stream of agent response chunks

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { Channel } from "@ibatexas/types";
import type { AgentContext } from "@ibatexas/types";
import { runAgent } from "@ibatexas/llm-provider";
import { loadSession, appendMessages } from "../session/store.js";
import { optionalAuth } from "../middleware/auth.js";
import {
  isStreamActive,
  createStream,
  pushChunk,
  getStream,
  cleanupStream,
} from "../streaming/emitter.js";

const PostMessageBody = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  channel: z.nativeEnum(Channel),
});

const PostMessageResponse = z.object({
  messageId: z.string().uuid(),
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

      if (isStreamActive(sessionId)) {
        void reply.status(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "Aguarde a resposta anterior.",
        } as never);
        return reply;
      }

      const history = await loadSession(sessionId);
      const messageId = uuidv4();

      await appendMessages(sessionId, [{ role: "user", content: message }], !!request.customerId);

      createStream(sessionId);

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
          for await (const chunk of runAgent(message, history, context)) {
            pushChunk(sessionId, chunk);
            if (chunk.type === "text_delta") {
              replyParts.push(chunk.delta);
            }
          }
          if (replyParts.length > 0) {
            await appendMessages(sessionId, [
              { role: "assistant", content: replyParts.join("") },
            ]);
          }
        } catch (err) {
          server.log.error(err, "[chat] Agent error");
          pushChunk(sessionId, { type: "error", message: "Erro interno." });
        } finally {
          cleanupStream(sessionId);
        }
      })();

      return reply.send({ messageId });
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
    },
    async (request, reply) => {
      const { sessionId } = request.params;

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
        return reply;
      }

      // Replay buffered chunks for late clients
      for (const chunk of entry.buffer) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.type === "done" || chunk.type === "error") {
          reply.raw.end();
          return reply;
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

      return reply;
    },
  );
}
