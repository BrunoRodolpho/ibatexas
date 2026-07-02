// NATS subscriber: conversation.message.appended
//
// Listens for CDC events from appendMessages() and persists conversation
// history to Postgres asynchronously. Redis is the hot path — this is
// best-effort durable archival.
//
// ── Task 16 (M3) — kernel-gated conversation append ───────────────────────
//
// Per the open-blockers doc (task 16 follow-up): the archiver should build
// `conversation.message.append` envelopes (SYSTEM taint, principal=system)
// and call `appendMessageFromEnvelope(envelope, state)`. The kernel runs a
// uniform audit gate against `conversationPolicyBundle` (SYSTEM-only at
// the taint floor — the LLM has no business mutating the archive).
//
//   - kind:               conversation.message.append
//   - actor.principal:    "system"
//   - actor.sessionId:    `conversation.message.appended:${sessionId}:${idx}`
//   - taint:              "SYSTEM"
//   - nonce:              `${sessionId}:${sentAt}:${idx}` (deterministic per message)
//
// On REFUSE the original NATS payload is pushed to the DLQ. The kernel
// adjudication is per-message — the policy's SYSTEM-only taint floor is
// the primary safety: a malicious actor with a forged NATS event cannot
// promote untrusted message content into the durable archive.

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import {
  createConversationService,
  type ConversationMessageAppendPayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import type { FastifyBaseLogger } from "fastify";
import { pushToDlq } from "./dlq.js";
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js";

export async function startConversationArchiver(
  log?: FastifyBaseLogger,
): Promise<void> {
  const svc = createConversationService({
    auditSink: getAuditSink(),
    ...(log ? { log } : {}),
  });

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

      let persistedCount = 0;
      let refusedCount = 0;

      for (let idx = 0; idx < messages.length; idx++) {
        const msg = messages[idx]!;
        const appendPayload: ConversationMessageAppendPayload = {
          conversationId,
          role: msg.role as "user" | "assistant" | "system",
          content: msg.content,
        };
        const envelope = buildSystemEnvelope({
          kind: "conversation.message.append" as const,
          payload: appendPayload,
          sourceSubject: "conversation.message.appended",
          eventId: `${sessionId}:${msg.sentAt}:${idx}`,
        });

        const outcome = await svc.appendMessageFromEnvelope(envelope, {
          ctx: { conversationExists: true },
        });

        if (
          outcome.decision.kind === "EXECUTE" ||
          outcome.decision.kind === "REWRITE"
        ) {
          persistedCount++;
        } else {
          refusedCount++;
          const refusalCode =
            outcome.decision.kind === "REFUSE"
              ? outcome.decision.refusal.code
              : undefined;
          log?.warn(
            { session_id: sessionId, msg_idx: idx, decision: outcome.decision.kind, refusalCode },
            "[conversation-archiver] kernel did not authorize message append",
          );
          if (outcome.decision.kind === "REFUSE") {
            await pushToDlq(
              "conversation.message.appended",
              { sessionId, customerId, channel, message: msg } as Record<string, unknown>,
              `kernel REFUSE: ${outcome.decision.refusal.code}`,
              log,
            );
          }
        }
      }

      // NOISE-6: the happy path (nothing refused) fired on EVERY archived
      // message and was the single largest subscriber emitter — demote it to
      // debug. Surface a warn only when the kernel refused a message (the
      // per-message REFUSE detail is already logged in the loop above).
      if (refusedCount > 0) {
        log?.warn(
          {
            component: "subscriber.conversation-archiver",
            event: "refused",
            session_id: sessionId,
            persisted: persistedCount,
            refused: refusedCount,
          },
          "[conversation-archiver] some messages refused by the kernel",
        );
      } else {
        log?.debug(
          {
            component: "subscriber.conversation-archiver",
            event: "persist",
            session_id: sessionId,
            persisted: persistedCount,
          },
          "[conversation-archiver] Messages processed",
        );
      }
    } catch (err) {
      log?.error(err, "[conversation-archiver] Failed to persist conversation messages");
      await pushToDlq("conversation.message.appended", payload as Record<string, unknown>, err, log);
    }
  }, { queueGroup: "conversation-archiver" });

  log?.info("[conversation-archiver] Subscribed to conversation.message.appended");
}
