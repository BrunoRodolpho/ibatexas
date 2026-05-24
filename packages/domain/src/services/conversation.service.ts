// ConversationService — durable conversation archive backed by Postgres.
//
// Redis stays the hot path for the LLM. This service writes via CDC:
// appendMessages() in the session store publishes a NATS event, and
// conversation-archiver.ts calls these methods asynchronously.
//
// ── Task 15 (M3) — envelope-typed entry points ───────────────────────────
//
// Methods `*FromEnvelope` route through the adjudicate kernel via
// `withAdjudicate` against a domain-local `conversationPolicyBundle`
// (these intents are SYSTEM-only — subscriber-driven archival; the LLM
// must never mutate the archive). pack-whatsapp governs the egress
// channel (Twilio sends), not the durable archive.

import { prisma } from "../client.js"
import { Prisma } from "../generated/prisma-client/client.js"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import {
  conversationPolicyBundle,
  type ConversationMessageAppendPayload,
  type ConversationDeletePayload,
  type ConversationDeleteAllPayload,
  type ConversationState,
} from "./__shared__/conversation-policy.js"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"

// ── Service ───────────────────────────────────────────────────────────────────

export interface ConversationServiceOptions {
  readonly auditSink?: AuditSink
  readonly log?: { readonly warn?: (...args: unknown[]) => void; readonly error?: (...args: unknown[]) => void }
}

export function createConversationService(options?: ConversationServiceOptions) {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.log ? { log: options.log } : {}),
  } as const

  return {
    /**
     * Upsert a Conversation row for the given session.
     * Idempotent — safe for NATS redelivery.
     */
    async findOrCreateBySessionId(params: {
      sessionId: string
      customerId: string | null
      channel: "whatsapp" | "web"
    }): Promise<{ id: string; isNew: boolean }> {
      const existing = await prisma.conversation.findUnique({
        where: { sessionId: params.sessionId },
        select: { id: true },
      })

      if (existing) {
        return { id: existing.id, isNew: false }
      }

      try {
        const created = await prisma.conversation.create({
          data: {
            sessionId: params.sessionId,
            customerId: params.customerId,
            channel: params.channel,
          },
          select: { id: true },
        })
        return { id: created.id, isNew: true }
      } catch (err) {
        // FK violation: customerId references a deleted customer (LGPD purge, NATS redelivery).
        // Retry without the customer link — the conversation is still worth archiving.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2003"
        ) {
          const created = await prisma.conversation.create({
            data: {
              sessionId: params.sessionId,
              customerId: null,
              channel: params.channel,
            },
            select: { id: true },
          })
          return { id: created.id, isNew: true }
        }
        throw err
      }
    },

    /**
     * Append a single message to a conversation.
     */
    async appendMessage(params: {
      conversationId: string
      role: "user" | "assistant" | "system"
      content: string
      metadata?: Record<string, unknown>
    }): Promise<{ id: string }> {
      return prisma.conversationMessage.create({
        data: {
          conversationId: params.conversationId,
          role: params.role,
          content: params.content,
          metadata: params.metadata as Parameters<typeof prisma.conversationMessage.create>[0]["data"]["metadata"],
        },
        select: { id: true },
      })
    },

    /**
     * Return all messages for a conversation ordered by sentAt (oldest first).
     */
    async getTranscript(conversationId: string): Promise<
      Array<{
        role: string
        content: string
        sentAt: Date
        metadata: unknown
      }>
    > {
      return prisma.conversationMessage.findMany({
        where: { conversationId },
        orderBy: { sentAt: "asc" },
        select: { role: true, content: true, sentAt: true, metadata: true },
      })
    },

    /**
     * Look up a Conversation by sessionId.
     */
    async findBySessionId(sessionId: string): Promise<{ id: string } | null> {
      return prisma.conversation.findUnique({
        where: { sessionId },
        select: { id: true },
      })
    },

    /**
     * Delete a conversation (and all its messages via cascade) by sessionId.
     * Returns true if a row was deleted, false if not found.
     */
    async deleteBySessionId(sessionId: string): Promise<boolean> {
      const existing = await prisma.conversation.findUnique({
        where: { sessionId },
        select: { id: true },
      })

      if (!existing) return false

      await prisma.conversation.delete({ where: { sessionId } })
      return true
    },

    /**
     * Delete all conversations (and messages via cascade).
     * Returns the number of conversations deleted.
     */
    async deleteAll(): Promise<number> {
      const result = await prisma.conversation.deleteMany()
      return result.count
    },

    /**
     * List recent conversations with message count and last message timestamp.
     */
    async listActive(limit = 50): Promise<
      Array<{
        id: string
        sessionId: string
        customerId: string | null
        channel: string
        messageCount: number
        lastMessageAt: Date | null
      }>
    > {
      const rows = await prisma.conversation.findMany({
        take: limit,
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          sessionId: true,
          customerId: true,
          channel: true,
          _count: { select: { messages: true } },
          messages: {
            take: 1,
            orderBy: { sentAt: "desc" },
            select: { sentAt: true },
          },
        },
      })

      return rows.map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        customerId: row.customerId,
        channel: row.channel,
        messageCount: row._count.messages,
        lastMessageAt: row.messages[0]?.sentAt ?? null,
      }))
    },

    // ── Task 15: envelope-typed entry points ────────────────────────────

    /**
     * Envelope-typed entry point for `conversation.message.append`.
     * SYSTEM-only — only the `conversation-archiver` NATS subscriber
     * emits it. Routes through the kernel before persisting.
     */
    async appendMessageFromEnvelope(
      envelope: IntentEnvelope<
        "conversation.message.append",
        ConversationMessageAppendPayload
      >,
      state: ConversationState,
      extras?: { readonly metadata?: Record<string, unknown> },
    ): Promise<AdjudicatedResult<{ id: string }>> {
      return withAdjudicate(
        envelope,
        state,
        conversationPolicyBundle,
        async (payload) => {
          return this.appendMessage({
            conversationId: payload.conversationId,
            role: payload.role,
            content: payload.content,
            ...(extras?.metadata !== undefined
              ? { metadata: extras.metadata }
              : {}),
          })
        },
        adjudicateOptions,
      )
    },

    /**
     * Envelope-typed entry point for `conversation.delete`. SYSTEM-only.
     * Triggered by LGPD purge cascade / ops CLI.
     */
    async deleteBySessionIdFromEnvelope(
      envelope: IntentEnvelope<"conversation.delete", ConversationDeletePayload>,
      state: ConversationState,
    ): Promise<AdjudicatedResult<boolean>> {
      return withAdjudicate(
        envelope,
        state,
        conversationPolicyBundle,
        async (payload) => {
          return this.deleteBySessionId(payload.sessionId)
        },
        adjudicateOptions,
      )
    },

    /**
     * Envelope-typed entry point for `conversation.delete_all`.
     * SYSTEM-only. Highest-blast-radius op in the service — guarded by
     * the SYSTEM taint floor and a `confirmationToken` payload field
     * (caller-projected — gives the kernel basis a stable artifact to
     * audit).
     */
    async deleteAllFromEnvelope(
      envelope: IntentEnvelope<
        "conversation.delete_all",
        ConversationDeleteAllPayload
      >,
      state: ConversationState,
    ): Promise<AdjudicatedResult<number>> {
      return withAdjudicate(
        envelope,
        state,
        conversationPolicyBundle,
        async () => {
          return this.deleteAll()
        },
        adjudicateOptions,
      )
    },
  }
}

export type ConversationService = ReturnType<typeof createConversationService>
