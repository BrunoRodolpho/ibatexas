// T1a-5 OFFLINE contract tests — ChatClient against a local node:http stub
// that emulates the chat route's header/SSE contract (apps/api/src/routes/
// chat.ts — each behavior below cites the line it mirrors). The stub is the
// contract oracle: it 403s exactly where the route 403s, so a client that
// fails to thread `x-session-secret` / `x-session-token` / the auth cookie
// (the `ibx api chat` reference bug, packages/cli/src/commands/api.ts:116-192)
// fails these tests.
import { describe, it, expect, afterEach } from "vitest"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { randomUUID } from "node:crypto"
import { onEvent, type IbxEventBase } from "@ibatexas/tools"
import { mintRenderedReply, unwrapRendered } from "@adjudicate/core"
import type { StreamChunk } from "@ibatexas/types"
import {
  ChatClient,
  ChatHttpError,
  ChatStreamError,
  ChatStreamIncompleteError,
  ChatTurnTimeoutError,
  type TurnBarrierContext,
} from "../chat-client.js"

// ── Stub chat server (route-contract emulation) ──────────────────────────────

interface RecordedPost {
  headers: IncomingHttpHeaders
  body: { sessionId: string; message: string; channel: string }
}

interface RecordedGet {
  headers: IncomingHttpHeaders
  sessionId: string
}

interface StubOptions {
  /** Reply chunks per turn (default: echo + done). MUST include a terminal. */
  reply?: (message: string, turn: number) => StreamChunk[]
  /**
   * Simulate dropped streams: the first N GET attempts per turn deliver only
   * `partialCount` chunks then end WITHOUT a terminal (the route's buffered
   * replay — chat.ts:456-464 — then re-delivers everything on the retry).
   */
  dropFirstAttempts?: number
  partialCount?: number
  /** Write SSE headers + heartbeat, then keep the stream open forever. */
  hangStream?: boolean
  /**
   * Answer the first N POSTs with the route's turn-lock 409
   * ("Aguarde a resposta anterior.", chat.ts:221-229) — the post-done
   * lock-release race the client retries through.
   */
  lockFirstPosts?: number
}

interface StubChat {
  url: string
  posts: RecordedPost[]
  gets: RecordedGet[]
  /** secrets minted per session (mirrors rk session:secret) */
  secrets: Map<string, string>
  /** freshest sessionToken per session (mirrors chat.ts:249-251) */
  tokens: Map<string, string>
  close(): Promise<void>
}

function sseWrite(res: NodeJS.WritableStream, chunk: StreamChunk): void {
  // Exact frame shape: `data: <json>\n\n` (chat.ts). EGRESS BRAND (E-1): the
  // server extracts the branded `text_delta` payload to a string on the wire
  // (chat.ts uses `chunkToWire`); mirror that so the SUT sees string deltas.
  const wire =
    chunk.type === "text_delta" ? { ...chunk, delta: unwrapRendered(chunk.delta) } : chunk
  res.write(`data: ${JSON.stringify(wire)}\n\n`)
}

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(part as Buffer)
  return JSON.parse(Buffer.concat(parts).toString("utf8"))
}

/** Extract the `token=` cookie value — the stub's stand-in for optionalAuth. */
function cookieCustomerId(headers: IncomingHttpHeaders): string | undefined {
  const cookie = headers["cookie"]
  if (typeof cookie !== "string") return undefined
  const match = /(?:^|;\s*)token=([^;]+)/.exec(cookie)
  return match?.[1]
}

async function createStubChat(options: StubOptions = {}): Promise<StubChat> {
  const reply =
    options.reply ??
    ((message: string): StreamChunk[] => [
      { type: "text_delta", delta: mintRenderedReply(`eco: ${message}`) },
      { type: "done" },
    ])
  const dropFirstAttempts = options.dropFirstAttempts ?? 0
  const partialCount = options.partialCount ?? 1

  const posts: RecordedPost[] = []
  const gets: RecordedGet[] = []
  const secrets = new Map<string, string>()
  const tokens = new Map<string, string>()
  const buffers = new Map<string, StreamChunk[]>()
  const getAttempts = new Map<string, number>()
  const turns = new Map<string, number>()

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://stub")

      // ── POST /api/chat/messages (chat.ts:147-333) ─────────────────────────
      if (req.method === "POST" && url.pathname === "/api/chat/messages") {
        const body = (await readJson(req)) as RecordedPost["body"]
        posts.push({ headers: { ...req.headers }, body })

        // Transient turn-lock (chat.ts:221-229).
        if (posts.length <= (options.lockFirstPosts ?? 0)) {
          res.writeHead(409, { "content-type": "application/json" })
          res.end(JSON.stringify({ statusCode: 409, message: "Aguarde a resposta anterior." }))
          return
        }

        const customerId = cookieCustomerId(req.headers)
        const responseExtras: Record<string, string> = {}

        if (customerId !== undefined) {
          // Authed: an x-session-token, when provided, must verify
          // (chat.ts:168-179) — the stub pins it to the last one it minted.
          const provided = req.headers["x-session-token"]
          const expected = tokens.get(body.sessionId)
          if (typeof provided === "string" && provided !== expected) {
            res.writeHead(403, { "content-type": "application/json" })
            res.end(JSON.stringify({ statusCode: 403, message: "Token de sessão inválido." }))
            return
          }
          // Fresh token on EVERY authed POST (chat.ts:249-251, :327-331);
          // same `sessionId.customerId.issuedAt.sig` shape as signed-claims.
          const minted = `${body.sessionId}.${customerId}.${Date.now()}.stubsig`
          tokens.set(body.sessionId, minted)
          responseExtras["sessionToken"] = minted
        } else {
          // Guest secret: verify-after-mint (chat.ts:200-209), mint-once
          // (chat.ts:211-214).
          const existing = secrets.get(body.sessionId)
          if (existing !== undefined) {
            if (req.headers["x-session-secret"] !== existing) {
              res.writeHead(403, { "content-type": "application/json" })
              res.end(JSON.stringify({ statusCode: 403, message: "Segredo de sessão inválido." }))
              return
            }
          } else {
            const minted = randomUUID()
            secrets.set(body.sessionId, minted)
            responseExtras["sessionSecret"] = minted
          }
        }

        const turn = (turns.get(body.sessionId) ?? 0) + 1
        turns.set(body.sessionId, turn)
        buffers.set(body.sessionId, reply(body.message, turn))
        getAttempts.set(body.sessionId, 0)

        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ messageId: randomUUID(), ...responseExtras }))
        return
      }

      // ── GET /api/chat/stream/:sessionId (chat.ts:337-540) ─────────────────
      const streamMatch = /^\/api\/chat\/stream\/(.+)$/.exec(url.pathname)
      if (req.method === "GET" && streamMatch) {
        const sessionId = decodeURIComponent(streamMatch[1]!)
        gets.push({ headers: { ...req.headers }, sessionId })

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        })

        // Guest secret gate on the stream (chat.ts:388-398): in-band SSE
        // error, NOT an HTTP status (the route is hijacked).
        const customerId = cookieCustomerId(req.headers)
        const expectedSecret = secrets.get(sessionId)
        if (
          customerId === undefined &&
          expectedSecret !== undefined &&
          req.headers["x-session-secret"] !== expectedSecret
        ) {
          sseWrite(res, { type: "error", message: "Acesso negado." })
          res.end()
          return
        }

        // Heartbeat comment line (chat.ts:433) — parsers must ignore it.
        res.write(`: ping\n\n`)

        if (options.hangStream) return // never terminates

        const buffer = buffers.get(sessionId)
        if (buffer === undefined) {
          // No producer (chat.ts:512-518).
          sseWrite(res, { type: "error", message: "Sessão não encontrada." })
          res.end()
          return
        }

        const attempt = (getAttempts.get(sessionId) ?? 0) + 1
        getAttempts.set(sessionId, attempt)

        if (attempt <= dropFirstAttempts) {
          // Dropped stream: partial delivery, clean end, NO terminal chunk.
          for (const chunk of buffer.slice(0, partialCount)) sseWrite(res, chunk)
          res.end()
          return
        }

        // Full buffered replay from the start of the turn (chat.ts:456-464).
        for (const chunk of buffer) sseWrite(res, chunk)
        res.end()
        return
      }

      res.writeHead(404)
      res.end()
    })().catch(() => {
      res.writeHead(500)
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("stub: no port")

  return {
    url: `http://127.0.0.1:${address.port}`,
    posts,
    gets,
    secrets,
    tokens,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ChatClient — offline contract (stub chat route)", () => {
  let stub: StubChat | undefined

  afterEach(async () => {
    await stub?.close()
    stub = undefined
  })

  it("guest two-turn conversation completes, echoing the dealt sessionSecret on POST and SSE GET", async () => {
    stub = await createStubChat()
    const client = new ChatClient({ baseUrl: stub.url })

    const turn1 = await client.perTurn("Oi")
    expect(turn1.replyText).toBe("eco: Oi")
    expect(turn1.turn).toBe(1)
    // First POST is secret-less; the response dealt one (chat.ts:211-214).
    expect(stub.posts[0]!.headers["x-session-secret"]).toBeUndefined()
    const secret = stub.secrets.get(client.sessionId)
    expect(client.sessionSecret).toBe(secret)
    // The FIRST SSE GET already carries it — the route rejects a secret-less
    // GET once a secret exists (chat.ts:388-398; the cli reference's bug).
    expect(stub.gets[0]!.headers["x-session-secret"]).toBe(secret)

    const turn2 = await client.perTurn("Tudo bem?")
    expect(turn2.replyText).toBe("eco: Tudo bem?")
    expect(turn2.turn).toBe(2)
    // Session reuse: POST #2 and GET #2 both echoed the secret (the stub
    // 403s the POST without it — chat.ts:200-209).
    expect(stub.posts[1]!.headers["x-session-secret"]).toBe(secret)
    expect(stub.gets[1]!.headers["x-session-secret"]).toBe(secret)
    expect(stub.posts).toHaveLength(2)
    expect(client.turnsCompleted).toBe(2)
  })

  it("a second secret-less client on the same session is 403d (ChatHttpError) — the contract the cli reference trips", async () => {
    stub = await createStubChat()
    const owner = new ChatClient({ baseUrl: stub.url })
    await owner.perTurn("Oi")

    const intruder = new ChatClient({ baseUrl: stub.url, sessionId: owner.sessionId })
    await expect(intruder.perTurn("Oi de novo")).rejects.toMatchObject({
      name: "ChatHttpError",
      status: 403,
    })
    await expect(
      intruder.perTurn("Oi de novo").catch((err: unknown) => {
        throw err
      }),
    ).rejects.toBeInstanceOf(ChatHttpError)
  })

  it("authenticated turns thread the cookie on BOTH POST and SSE GET and echo the freshest sessionToken", async () => {
    stub = await createStubChat()
    const cookie = "token=cust-123"
    const client = new ChatClient({ baseUrl: stub.url, cookie })

    await client.perTurn("Olá")
    expect(stub.posts[0]!.headers["cookie"]).toBe(cookie)
    expect(stub.gets[0]!.headers["cookie"]).toBe(cookie)
    // Authed POSTs never deal a guest secret (chat.ts:194-215 guards on
    // !request.customerId); they deal a sessionToken instead (:249-251).
    expect(client.sessionSecret).toBeUndefined()
    const token1 = client.sessionToken
    expect(token1).toBe(stub.tokens.get(client.sessionId))
    expect(token1).toContain(`.cust-123.`)

    await client.perTurn("Segunda mensagem")
    // POST #2 echoed token #1 (the stub 403s a mismatched echo, mirroring
    // chat.ts:168-179)…
    expect(stub.posts[1]!.headers["x-session-token"]).toBe(token1)
    // …whose response dealt token #2 (every authed POST refreshes —
    // chat.ts:249-251), so GET #2 already carries the FRESHEST token.
    const token2 = stub.tokens.get(client.sessionId)
    expect(token2).not.toBe(token1)
    expect(stub.gets[1]!.headers["x-session-token"]).toBe(token2)
    expect(stub.gets[1]!.headers["cookie"]).toBe(cookie)
    expect(client.sessionToken).toBe(token2)
  })

  it("tolerates a dropped stream via buffered replay — idempotent accumulation, first done wins", async () => {
    stub = await createStubChat({
      reply: () => [
        { type: "text_delta", delta: mintRenderedReply("Olá") },
        { type: "text_delta", delta: mintRenderedReply(" mundo") },
        { type: "done" },
      ],
      dropFirstAttempts: 1,
      partialCount: 1,
    })
    const client = new ChatClient({ baseUrl: stub.url })

    const turn = await client.perTurn("Oi")
    // Attempt 1 delivered "Olá" then dropped; attempt 2 REPLAYED the full
    // buffer (chat.ts:456-464). Idempotent handling: no "OláOlá mundo".
    expect(turn.replyText).toBe("Olá mundo")
    expect(stub.gets).toHaveLength(2)
    // The trace keeps the raw frames of BOTH attempts, attempt-tagged.
    expect(turn.events.filter((e) => e.attempt === 1)).toHaveLength(1)
    expect(turn.events.filter((e) => e.attempt === 2)).toHaveLength(3)
  })

  it("ignores frames after the first done (terminal contract — chat.ts:459-463)", async () => {
    stub = await createStubChat({
      reply: () => [
        { type: "text_delta", delta: mintRenderedReply("ok") },
        { type: "done" },
        { type: "text_delta", delta: mintRenderedReply("EXTRA") },
        { type: "done" },
      ],
    })
    const client = new ChatClient({ baseUrl: stub.url })
    const turn = await client.perTurn("Oi")
    expect(turn.replyText).toBe("ok")
  })

  it("surfaces tokens from the done chunk when the SUT reports them", async () => {
    stub = await createStubChat({
      reply: () => [
        { type: "text_delta", delta: mintRenderedReply("resp") },
        { type: "done", inputTokens: 321, outputTokens: 45 },
      ],
    })
    const client = new ChatClient({ baseUrl: stub.url })
    const turn = await client.perTurn("Oi")
    expect(turn.inputTokens).toBe(321)
    expect(turn.outputTokens).toBe(45)
  })

  it("SSE error chunk → ChatStreamError carrying the SUT's pt-BR message", async () => {
    stub = await createStubChat({
      reply: () => [{ type: "error", message: "Erro interno." }],
    })
    const client = new ChatClient({ baseUrl: stub.url })
    const rejection = await client.perTurn("Oi").then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(rejection).toBeInstanceOf(ChatStreamError)
    expect((rejection as ChatStreamError).sutMessage).toBe("Erro interno.")
  })

  it("exhausted stream attempts without done → ChatStreamIncompleteError", async () => {
    stub = await createStubChat({
      reply: () => [
        { type: "text_delta", delta: mintRenderedReply("nunca termina") },
        { type: "done" },
      ],
      dropFirstAttempts: 99,
      partialCount: 1,
    })
    const client = new ChatClient({ baseUrl: stub.url, maxStreamAttempts: 2 })
    await expect(client.perTurn("Oi")).rejects.toBeInstanceOf(ChatStreamIncompleteError)
    expect(stub.gets).toHaveLength(2)
  })

  it("retries the transient turn-lock 409 (post-done release race, chat.ts:307 vs :316-324)", async () => {
    stub = await createStubChat({ lockFirstPosts: 2 })
    const client = new ChatClient({ baseUrl: stub.url })
    const turn = await client.perTurn("Oi")
    expect(turn.replyText).toBe("eco: Oi")
    // Two 409s + the successful POST.
    expect(stub.posts).toHaveLength(3)
  })

  it("hung stream → ChatTurnTimeoutError at turnTimeoutMs", async () => {
    stub = await createStubChat({ hangStream: true })
    const client = new ChatClient({ baseUrl: stub.url, turnTimeoutMs: 300 })
    await expect(client.perTurn("Oi")).rejects.toBeInstanceOf(ChatTurnTimeoutError)
  })

  it("awaits the injected barrier AFTER done (T1a-6 composition seam)", async () => {
    stub = await createStubChat()
    const calls: TurnBarrierContext[] = []
    const client = new ChatClient({
      baseUrl: stub.url,
      journeyId: "JOURNEY-000",
      runId: "run-1",
      barrier: async (ctx) => {
        calls.push(ctx)
      },
    })

    const turn = await client.perTurn("Oi")
    expect(calls).toHaveLength(1)
    // The barrier sees the COMPLETED turn (post-done): replyText is final.
    expect(calls[0]).toMatchObject({
      sessionId: client.sessionId,
      turn: 1,
      messageId: turn.messageId,
      replyText: "eco: Oi",
      journeyId: "JOURNEY-000",
      runId: "run-1",
    })
    expect(turn.timings.barrierMs).toBeGreaterThanOrEqual(0)
  })

  it("emits chat.turn.start/end trace events with timings via @ibatexas/tools", async () => {
    stub = await createStubChat()
    const captured: IbxEventBase[] = []
    const unsub = onEvent((e) => {
      if (e.type === "chat.turn.start" || e.type === "chat.turn.end") captured.push(e)
    })
    try {
      const client = new ChatClient({
        baseUrl: stub.url,
        journeyId: "JOURNEY-000",
        runId: "run-1",
      })
      await client.perTurn("Oi")

      expect(captured.map((e) => e.type)).toEqual(["chat.turn.start", "chat.turn.end"])
      const [start, end] = captured
      expect(start).toMatchObject({
        sessionId: client.sessionId,
        turn: 1,
        journey: "JOURNEY-000",
        runId: "run-1",
      })
      expect(end).toMatchObject({ sessionId: client.sessionId, turn: 1, outcome: "pass" })
      expect(end!.duration).toBeGreaterThanOrEqual(0)
      expect(end!.detail).toMatch(/post=\d+ms stream=\d+ms/)
    } finally {
      unsub()
    }
  })

  it("emits chat.turn.end with outcome=error when the turn fails (no secret leakage in detail)", async () => {
    stub = await createStubChat({
      reply: () => [{ type: "error", message: "Erro interno." }],
    })
    const captured: IbxEventBase[] = []
    const unsub = onEvent((e) => {
      if (e.type === "chat.turn.end") captured.push(e)
    })
    try {
      const client = new ChatClient({ baseUrl: stub.url })
      await expect(client.perTurn("Oi")).rejects.toBeInstanceOf(ChatStreamError)
      expect(captured).toHaveLength(1)
      expect(captured[0]).toMatchObject({ outcome: "error", turn: 1 })
      expect(captured[0]!.detail).toContain("ChatStreamError")
    } finally {
      unsub()
    }
  })
})
