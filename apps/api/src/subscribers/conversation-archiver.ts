// NATS subscriber: conversation.message.appended
//
// Listens for CDC events from appendMessages() and persists conversation
// history to Postgres asynchronously. Redis is the hot path — this is
// best-effort durable archival.

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { createConversationService } from "@ibatexas/domain";
import type { FastifyBaseLogger } from "fastify";
import { pushToDlq } from "./dlq.js";

export async function startConversationArchiver(
  log?: FastifyBaseLogger,
): Promise<void> {
  const svc = createConversationService();

  await subscribeNatsEvent("conversation.message.appended", async (payload) => {
    const { sessionId, customerId, channel, messages } = payload as {
      sessionId: string;
      customerId: string | null;
      channel: "whatsapp" | "web";
      messages: Array<{ role: string; content: string; sentAt: string }>;
    };

    try {
      const { id: conversationId } = await svc.findOrCreateBySessionId({
        sessionId,
        customerId,
        channel,
      });

      // P3-PERF-ARCHIVER: batch-insert all messages in one createMany call instead
      // of a sequential per-message await loop.
      await svc.appendMessages({
        conversationId,
        messages: messages.map((msg) => ({
          role: msg.role as "user" | "assistant" | "system",
          content: msg.content,
        })),
      });

      log?.info(
        { session_id: sessionId, message_count: messages.length },
        "[conversation-archiver] Messages persisted",
      );
    } catch (err) {
      log?.error(err, "[conversation-archiver] Failed to persist conversation messages");
      await pushToDlq("conversation.message.appended", payload as Record<string, unknown>, err, log);
    }
  });

  log?.info("[conversation-archiver] Subscribed to conversation.message.appended");
}
