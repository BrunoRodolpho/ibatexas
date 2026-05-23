// ConversationService — envelope-typed entry-point smoke tests.
//
// Task 15 (M3): demonstrates the chokepoint applies to the conversation
// archive too. Coverage is intentionally narrow — the legacy Conversation
// tests stay the primary suite. These tests verify the envelope path
// dispatches correctly through the kernel.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import { randomUUID } from "node:crypto"

const mockMessageCreate = vi.hoisted(() => vi.fn())
const mockConversationFindUnique = vi.hoisted(() => vi.fn())
const mockConversationDelete = vi.hoisted(() => vi.fn())
const mockConversationDeleteMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    conversation: {
      findUnique: mockConversationFindUnique,
      delete: mockConversationDelete,
      deleteMany: mockConversationDeleteMany,
    },
    conversationMessage: { create: mockMessageCreate },
  },
}))

vi.mock("../../generated/prisma-client/client.js", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class {
      code = ""
    },
  },
}))

import { createConversationService } from "../conversation.service.js"
import type {
  ConversationMessageAppendPayload,
  ConversationDeletePayload,
  ConversationDeleteAllPayload,
  ConversationState,
} from "../__shared__/conversation-policy.js"

const systemActor = () => ({
  principal: "system" as const,
  sessionId: "system:test-suite",
})

const llmActor = () => ({
  principal: "llm" as const,
  sessionId: "llm:test-suite",
})

describe("ConversationService — envelope-typed entry points", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("appendMessageFromEnvelope EXECUTE: persists the message", async () => {
    const svc = createConversationService()
    mockMessageCreate.mockResolvedValue({ id: "msg_01" })

    const payload: ConversationMessageAppendPayload = {
      conversationId: "conv_01",
      role: "user",
      content: "Olá!",
    }
    const envelope = buildEnvelope({
      kind: "conversation.message.append" as const,
      payload,
      nonce: randomUUID(),
      actor: systemActor(),
      taint: "SYSTEM",
    })
    const state: ConversationState = { ctx: { conversationExists: true } }

    const outcome = await svc.appendMessageFromEnvelope(envelope, state)

    expect(outcome.decision.kind).toBe("EXECUTE")
    expect(outcome.result).toEqual({ id: "msg_01" })
    expect(mockMessageCreate).toHaveBeenCalledOnce()
  })

  it("appendMessageFromEnvelope REFUSE: UNTRUSTED actor blocked", async () => {
    const svc = createConversationService()
    const payload: ConversationMessageAppendPayload = {
      conversationId: "conv_01",
      role: "user",
      content: "Olá!",
    }
    const envelope = buildEnvelope({
      kind: "conversation.message.append" as const,
      payload,
      nonce: randomUUID(),
      actor: llmActor(),
      taint: "UNTRUSTED",
    })
    const state: ConversationState = { ctx: { conversationExists: true } }

    const outcome = await svc.appendMessageFromEnvelope(envelope, state)

    expect(outcome.decision.kind).toBe("REFUSE")
    expect(mockMessageCreate).not.toHaveBeenCalled()
  })

  it("deleteBySessionIdFromEnvelope EXECUTE: deletes the conversation", async () => {
    const svc = createConversationService()
    mockConversationFindUnique.mockResolvedValue({ id: "conv_01" })
    mockConversationDelete.mockResolvedValue({})

    const payload: ConversationDeletePayload = { sessionId: "session_01" }
    const envelope = buildEnvelope({
      kind: "conversation.delete" as const,
      payload,
      nonce: randomUUID(),
      actor: systemActor(),
      taint: "SYSTEM",
    })

    const outcome = await svc.deleteBySessionIdFromEnvelope(envelope, {
      ctx: {},
    })

    expect(outcome.decision.kind).toBe("EXECUTE")
    expect(outcome.result).toBe(true)
  })

  it("deleteAllFromEnvelope REFUSE: blocks non-SYSTEM taint", async () => {
    const svc = createConversationService()
    const payload: ConversationDeleteAllPayload = {
      confirmationToken: "test-only",
    }
    const envelope = buildEnvelope({
      kind: "conversation.delete_all" as const,
      payload,
      nonce: randomUUID(),
      actor: llmActor(),
      taint: "UNTRUSTED",
    })

    const outcome = await svc.deleteAllFromEnvelope(envelope, { ctx: {} })

    expect(outcome.decision.kind).toBe("REFUSE")
    expect(mockConversationDeleteMany).not.toHaveBeenCalled()
  })
})
