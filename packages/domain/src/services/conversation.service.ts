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
import { toE164BR } from "../phone.js"
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
     * Batch-append multiple messages in a single createMany call.
     * Preserves insertion order (Postgres assigns sentAt server-side, ordering
     * is stable within a transaction for the batch). Idempotent per
     * (conversationId, role, content, sentAt) — duplicates are silently skipped
     * via skipDuplicates.
     * P3-PERF-ARCHIVER: replaces sequential per-message INSERT loop in the subscriber.
     */
    async appendMessages(params: {
      conversationId: string
      messages: Array<{
        role: "user" | "assistant" | "system"
        content: string
        metadata?: Record<string, unknown>
      }>
    }): Promise<{ count: number }> {
      if (params.messages.length === 0) return { count: 0 }
      const result = await prisma.conversationMessage.createMany({
        data: params.messages.map((msg) => ({
          conversationId: params.conversationId,
          role: msg.role,
          content: msg.content,
          metadata: msg.metadata as Parameters<typeof prisma.conversationMessage.create>[0]["data"]["metadata"],
        })),
        skipDuplicates: true,
      })
      return { count: result.count }
    },

    /**
     * Return the most-recent messages for a conversation ordered by sentAt (oldest first).
     * Capped at 500 rows — enough to cover any realistic LLM context window while
     * preventing unbounded memory consumption on runaway conversations.
     * P2-PERF-TRANSCRIPT: unbounded findMany replaced with a bounded take.
     */
    async getTranscript(conversationId: string): Promise<
      Array<{
        role: string
        content: string
        sentAt: Date
        metadata: unknown
      }>
    > {
      // Fetch desc + take so we get the newest 500, then reverse for asc presentation.
      const rows = await prisma.conversationMessage.findMany({
        where: { conversationId },
        orderBy: { sentAt: "desc" },
        take: 500,
        select: { role: true, content: true, sentAt: true, metadata: true },
      })
      return rows.reverse()
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

    /**
     * List a single customer's conversations (newest first), with message count
     * + last-message timestamp. NET-NEW for the admin conversation surface (D1):
     * `listActive` has no per-customer filter. Same summary shape as listActive.
     */
    async findByCustomerId(
      customerId: string,
      limit = 50,
    ): Promise<
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
        where: { customerId },
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

    /**
     * Unified conversation search for the admin surface (D1). Dispatches on the
     * provided filter, most-specific first: sessionId → customerId → phone
     * (resolved to a customerId via the canonicalized Customer.phone @unique) →
     * else the recent-activity list. Returns listActive-shaped summaries.
     */
    async searchConversations(params: {
      sessionId?: string
      customerId?: string
      phone?: string
      limit?: number
    }): Promise<
      Array<{
        id: string
        sessionId: string
        customerId: string | null
        channel: string
        messageCount: number
        lastMessageAt: Date | null
      }>
    > {
      const limit = params.limit ?? 50
      if (params.sessionId) {
        const rows = await prisma.conversation.findMany({
          where: { sessionId: params.sessionId },
          take: 1,
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
      }
      if (params.customerId) {
        return this.findByCustomerId(params.customerId, limit)
      }
      if (params.phone) {
        // Resolve phone → customerId at the canonicalized @unique boundary
        // (same toE164BR used at write time, so the lookup never misses on a
        // formatted variant). toE164BR THROWS on a non-E.164 input (it doesn't
        // add a country code) — a malformed search phone must degrade to "no
        // results", never a 500. No customer → no conversations.
        let canonical: string
        try {
          canonical = toE164BR(params.phone)
        } catch {
          return []
        }
        const customer = await prisma.customer.findUnique({
          where: { phone: canonical },
          select: { id: true },
        })
        if (!customer) return []
        return this.findByCustomerId(customer.id, limit)
      }
      return this.listActive(limit)
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
