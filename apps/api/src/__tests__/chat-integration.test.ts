// Integration test: Chat POST → Stream coordination
// Tests POST /api/chat/messages validation and stream lifecycle
//
// Mocks: runAgent, Redis (session store), uuid

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest"
import Fastify from "fastify"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import type { FastifyInstance } from "fastify"
import { chatRoutes } from "../routes/chat.js"

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockRunAgent = vi.hoisted(() =>
  vi.fn(async function* () {
    yield { type: "text_delta" as const, delta: "Olá!" }
    yield { type: "done" as const }
  }),
)

const mockLoadSession = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockAppendMessages = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("@ibatexas/llm-provider", () => ({
  runOrchestrator: mockRunAgent,
}))

vi.mock("../session/store.js", () => ({
  loadSession: mockLoadSession,
  appendMessages: mockAppendMessages,
}))

vi.mock("uuid", () => ({
  v4: () => "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
}))

vi.mock("../streaming/execution-queue.js", () => ({
  acquireWebAgentLock: vi.fn().mockResolvedValue(true),
  releaseWebAgentLock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return {
    ...orig,
    getRedisClient: vi.fn().mockResolvedValue({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
    }),
  }
})

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(sensible)
  await app.register(chatRoutes)
  await app.ready()
  return app
}

describe("Chat routes integration", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockRunAgent.mockImplementation(async function* () {
      yield { type: "text_delta" as const, delta: "Olá!" }
      yield { type: "done" as const }
    })
  })

  it("POST returns 200 with messageId for valid request", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: "11111111-2222-4333-a444-555555555555",
        message: "Quero ver o cardápio",
        channel: "web",
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.messageId).toBe("aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee")

    // Wait for fire-and-forget agent + cleanup delay
    await new Promise((r) => setTimeout(r, 200))
  })

  it("POST validates required fields", async () => {
    // Missing message
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: "11111111-2222-4333-a444-555555555555",
        channel: "web",
      },
    })

    expect(res.statusCode).toBe(400)
  })

  it("POST validates sessionId is UUID", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: "not-a-uuid",
        message: "Olá",
        channel: "web",
      },
    })

    expect(res.statusCode).toBe(400)
  })

  it("POST validates channel enum", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: "11111111-2222-4333-a444-555555555555",
        message: "Olá",
        channel: "telegram", // not a valid channel
      },
    })

    expect(res.statusCode).toBe(400)
  })

  it("POST validates message max length", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: "11111111-2222-4333-a444-555555555555",
        message: "x".repeat(2001),
        channel: "web",
      },
    })

    expect(res.statusCode).toBe(400)
  })

  it("POST loads session history before running agent", async () => {
    mockLoadSession.mockResolvedValue([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Olá!" },
    ])

    // Use a DIFFERENT sessionId from other tests to avoid 409 Conflict
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: "22222222-3333-4444-a555-666666666666",
        message: "E o cardápio?",
        channel: "web",
      },
    })

    expect(res.statusCode).toBe(200)

    // Wait for fire-and-forget agent loop to complete
    await new Promise((r) => setTimeout(r, 200))

    expect(mockLoadSession).toHaveBeenCalledWith("22222222-3333-4444-a555-666666666666")
    // appendMessages is called twice: once for user message (sync, before agent), once for assistant (fire-and-forget)
    expect(mockAppendMessages).toHaveBeenCalledWith(
      "22222222-3333-4444-a555-666666666666",
      [{ role: "user", content: "E o cardápio?" }],
      false,
      { customerId: undefined, channel: "web" },
    )
  })

  it("GET /api/chat/stream/:sessionId returns 404 for non-existent stream", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/chat/stream/99999999-9999-4999-a999-999999999999",
    })

    // SSE endpoint writes error via raw response, not JSON status
    // The response will timeout/write error event
    expect(res.statusCode).toBe(200) // SSE always 200
    expect(res.headers["content-type"]).toBe("text/event-stream")
    // Body should contain the timeout/error event
    expect(res.body).toContain("Sessão não encontrada")
  })
})
