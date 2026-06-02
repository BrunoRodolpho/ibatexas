// Integration test: Chat POST → Stream coordination
// Tests POST /api/chat/messages validation and stream lifecycle
//
// Mocks: Redis (session store), uuid, the claustrum conductor

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

const mockLoadSession = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockAppendMessages = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

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

// Conductor delegation (the routed cutover path). The chat POST forwards the
// turn to getConductor() → openCapsule → handleTurn(@claustrum/core) →
// closeCapsule, fire-and-forget after the sync 200.
const mockGetConductor = vi.hoisted(() => vi.fn())
const mockTryGetConductor = vi.hoisted(() => vi.fn())
const mockHandleTurn = vi.hoisted(() => vi.fn())
const mockOpenCapsule = vi.hoisted(() => vi.fn())
const mockCloseCapsule = vi.hoisted(() => vi.fn())

vi.mock("../claustrum-bootstrap.js", () => ({
  getConductor: mockGetConductor,
  tryGetConductor: mockTryGetConductor,
}))

vi.mock("@claustrum/core", () => ({
  handleTurn: mockHandleTurn,
}))

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  // Minimal Redis stub. Includes the pub/sub + replay-list surface the real
  // streaming emitter touches so the cross-replica SSE path resolves cleanly
  // (empty replay list ⇒ "Sessão não encontrada.") instead of crashing on a
  // missing duplicate()/subscribe(). No data is published, so the GET-not-found
  // assertion below is unchanged.
  //
  // P2-SEC-SSECORS: the SSE GET now verifies a guest's x-session-secret against
  // the stored session:secret. Return a fixed secret for that key so guest GET/
  // POST requests carrying the matching header pass the check; null otherwise.
  const makeRedisStub = (): Record<string, unknown> => ({
    get: vi.fn().mockImplementation(async (key: string) =>
      key.includes("session:secret") ? "integration-guest-secret" : null,
    ),
    set: vi.fn().mockResolvedValue("OK"),
    duplicate: () => makeRedisStub(),
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    rPush: vi.fn().mockResolvedValue(1),
    lRange: vi.fn().mockResolvedValue([]),
    lTrim: vi.fn().mockResolvedValue("OK"),
    expire: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue("OK"),
  })
  return {
    ...orig,
    getRedisClient: vi.fn().mockResolvedValue(makeRedisStub()),
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
    // Conductor delegation resolves cleanly (the route runs it fire-and-forget).
    mockOpenCapsule.mockResolvedValue({ id: "capsule-web-1" })
    mockHandleTurn.mockResolvedValue({ response: { text: "Olá!" } })
    mockCloseCapsule.mockResolvedValue(undefined)
    mockGetConductor.mockReturnValue({
      openCapsule: mockOpenCapsule,
      closeCapsule: mockCloseCapsule,
    })
    // Conductor is bootstrapped (flag ON) by default → the routed path is taken.
    // The flag-OFF legacy fallback test below overrides this to null.
    mockTryGetConductor.mockReturnValue({
      openCapsule: mockOpenCapsule,
      closeCapsule: mockCloseCapsule,
    })
  })

  it("POST returns 200 with messageId for valid request", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/messages",
      // Guest with the matching stored secret (stub returns it for session:secret).
      headers: { "x-session-secret": "integration-guest-secret" },
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

  // Un-skipped + rewritten for the claustrum cutover (was "POST loads session
  // history before running agent"). The chat route no longer calls the legacy
  // session store (loadSession/appendMessages) — it delegates the turn to the
  // Conductor: getConductor() → openCapsule → handleTurn → closeCapsule. This
  // asserts that ROUTED delegation. NOTE (documented residual): session-history
  // loading is now the Conductor's SessionPort responsibility, whose adapter is
  // a stub today (returns a fresh session, no history). Implementing the
  // SessionPort adapter so prior turns are loaded is a post-activation follow-up
  // — it is NOT a routing gap (the route delegates correctly), and it is inert
  // until the flag flips.
  it("POST delegates the turn to the conductor (openCapsule → handleTurn → closeCapsule)", async () => {
    // Different sessionId from other tests to avoid a 409 Conflict.
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { "x-session-secret": "integration-guest-secret" },
      payload: {
        sessionId: "22222222-3333-4444-a555-666666666666",
        message: "E o cardápio?",
        channel: "web",
      },
    })

    expect(res.statusCode).toBe(200)

    // The conductor turn runs fire-and-forget after the sync 200 — wait for it.
    await vi.waitFor(
      () => {
        expect(mockGetConductor).toHaveBeenCalled()
        expect(mockOpenCapsule).toHaveBeenCalledTimes(1)
        expect(mockHandleTurn).toHaveBeenCalledTimes(1)
        expect(mockCloseCapsule).toHaveBeenCalledTimes(1)
      },
      { timeout: 1000 },
    )

    // Delegation opened the capsule on the web channel for this session.
    const openArg = mockOpenCapsule.mock.calls[0][0] as {
      channel: string
      sessionKey: string
    }
    expect(openArg.channel).toBe("web")
    expect(openArg.sessionKey).toBe("22222222-3333-4444-a555-666666666666")
  })


  it("GET /api/chat/stream/:sessionId returns 404 for non-existent stream", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/chat/stream/99999999-9999-4999-a999-999999999999",
      // Guest stream → carry the matching secret so we reach the not-found path
      // rather than the new P2-SEC-SSECORS access-denied gate.
      headers: { "x-session-secret": "integration-guest-secret" },
    })

    // SSE endpoint writes error via raw response, not JSON status
    // The response will timeout/write error event
    expect(res.statusCode).toBe(200) // SSE always 200
    expect(res.headers["content-type"]).toBe("text/event-stream")
    // Body should contain the timeout/error event
    expect(res.body).toContain("Sessão não encontrada")
  })
})
