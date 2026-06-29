// clients/chat-client.ts — T1a-5 ChatClient: secret + cookie threading over
// the SUT's public chat surface.
//
// REWRITE-WITH-REFERENCE of `packages/cli/src/commands/api.ts:116-192` (the
// `ibx api chat` POST+SSE helpers). NOT a lift: that implementation never
// sends `x-session-secret`/`x-session-token`, so the second guest POST 403s
// ("Segredo de sessão inválido.") and even the first SSE GET is rejected once
// the secret is minted. This client implements the route's FULL header/cookie
// contract. Every contract pin below cites `apps/api/src/routes/chat.ts`
// (read, never imported — check-bypass leg 7 forbids journeys→apps/api):
//
//   POST /api/chat/messages
//     body            { sessionId: uuid, message: 1..2000, channel }  (:52-56)
//     response        { messageId, sessionToken?, sessionSecret? }    (:58-62, :327-331)
//     guest secret    first POST mints sessionSecret (1h TTL, :211-214);
//                     EVERY subsequent guest POST must echo it as
//                     `x-session-secret` or 403 (:200-209).
//     authed token    sessionToken minted on EVERY authed POST (:249-251);
//                     when echoed back as `x-session-token` it must match
//                     {sessionId, customerId} or 403 (:168-179). Ownership
//                     additionally pinned via Redis session:owner (:181-191).
//     409             concurrent turn on the same session (:221-229).
//
//   GET /api/chat/stream/:sessionId   (SSE — reply.hijack()ed)
//     guest secret    when a secret EXISTS for the session, the GET must echo
//                     `x-session-secret` or the stream is an immediate
//                     `error "Acesso negado."` event (:388-398).
//     authed cookie   optionalAuth (`token=` cookie) + session:owner check
//                     (:368-379) — same cookie as the POST.
//     frames          `data: <json StreamChunk>\n\n` (:458, :468, :496);
//                     heartbeat comment lines `: ping\n\n` (:429-440) are
//                     ignored by parsers.
//     terminal        the stream ENDS at the first `done`/`error` chunk
//                     (:459-463, :470-474, :497-503) — `done` is the turn-
//                     completion signal.
//     replay          buffered chunks are REPLAYED from the start of the turn
//                     for late/reconnecting clients (:456-464) — so a retry
//                     after a dropped stream re-delivers earlier deltas, and
//                     this client handles frames idempotently (each attempt
//                     re-accumulates from scratch; first `done` wins).
//     not found       no stream after the 2s producer grace → an
//                     `error "Sessão não encontrada."` event (:512-518).
//
// Auth cookie (authenticated journeys): the `token=` cookie value produced by
// the T1a-4 authFixture (`cookieHeader(mintCustomerToken(...))`) is threaded
// on BOTH the POST and the SSE GET — the API has no header auth path for
// customers (auth-fixture.ts pins).
//
// Trace events: the client emits `chat.turn.start`/`chat.turn.end` through
// the @ibatexas/tools emitter — the CLIENT-side llm boundary (turn
// wall-clock). The SUT's own provider costs are measured server-side
// (`llm.call`); this client never emits `llm.call`.
//
// Barrier seam (T1a-6): after `done`, an OPTIONAL injected barrier is awaited
// (audit/projection settle) — a composition seam typed locally, never a hard
// dependency on the oracle kit.

import { randomUUID } from "node:crypto"
import { emitChatTurnStart, emitChatTurnEnd } from "@ibatexas/tools"
import { Channel, type StreamChunk } from "@ibatexas/types"

// ── Named errors ─────────────────────────────────────────────────────────────

/** Base class for every ChatClient failure (catchable as one family). */
export class ChatClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChatClientError"
  }
}

/** Non-2xx HTTP response (e.g. the guest-secret 403 or the turn-lock 409). */
export class ChatHttpError extends ChatClientError {
  readonly status: number
  readonly body: string

  constructor(op: string, status: number, body: string) {
    super(`${op} failed: HTTP ${status}` + (body ? ` — ${body}` : ""))
    this.name = "ChatHttpError"
    this.status = status
    this.body = body
  }
}

/**
 * The SUT terminated the stream with an `error` chunk (chat.ts pushes
 * pt-BR messages, e.g. "Acesso negado." / "Sessão não encontrada." /
 * "Erro interno."). `sutMessage` carries it verbatim for the trace.
 */
export class ChatStreamError extends ChatClientError {
  readonly sutMessage: string

  constructor(sessionId: string, sutMessage: string) {
    super(`SSE stream for session ${sessionId} ended with error chunk: ${sutMessage}`)
    this.name = "ChatStreamError"
    this.sutMessage = sutMessage
  }
}

/** Stream attempts exhausted without ever receiving a terminal `done`. */
export class ChatStreamIncompleteError extends ChatClientError {
  constructor(sessionId: string, attempts: number) {
    super(
      `SSE stream for session ${sessionId} ended without a 'done' chunk after ` +
        `${attempts} attempt(s) — turn completion (chat.ts:459-463) never observed`,
    )
    this.name = "ChatStreamIncompleteError"
  }
}

/** The per-turn wall-clock deadline elapsed before `done`. */
export class ChatTurnTimeoutError extends ChatClientError {
  constructor(sessionId: string, timeoutMs: number) {
    super(`turn on session ${sessionId} exceeded turnTimeoutMs=${timeoutMs}`)
    this.name = "ChatTurnTimeoutError"
  }
}

// ── Turn result shapes ───────────────────────────────────────────────────────

/** One raw SSE chunk as observed on the wire, kept for the JSONL trace. */
export interface ChatTraceEvent {
  /** 1-based SSE GET attempt that delivered this chunk (replay-aware). */
  attempt: number
  /** Client receive time (ISO). */
  at: string
  /** The parsed frame — exactly the route's StreamChunk union. */
  chunk: StreamChunk
}

export interface ChatTurnTimings {
  /** Turn start (ISO) — immediately before the POST. */
  startedAt: string
  /** POST /api/chat/messages round-trip (ms). */
  postMs: number
  /** SSE open → terminal `done` across all attempts (ms). */
  streamMs: number
  /** Barrier wait (ms) — present only when a barrier was injected. */
  barrierMs?: number
  /** Full turn wall-clock: POST start → done (+ barrier when injected). */
  totalMs: number
}

export interface ChatTurn {
  /** 1-based turn number within this client's conversation. */
  turn: number
  sessionId: string
  /** SUT-assigned message id (POST response, chat.ts:231/:327). */
  messageId: string
  /** Concatenated `text_delta` deltas of the completed turn. */
  replyText: string
  /** Raw SSE chunks (all attempts) for the trace. */
  events: ChatTraceEvent[]
  timings: ChatTurnTimings
  /**
   * Surfaced from the terminal `done` chunk when the SUT reports them
   * (StreamChunk allows it; the web route's done is bare — chat.ts:307).
   */
  inputTokens?: number
  outputTokens?: number
}

// ── Barrier seam (T1a-6 composition point — NOT a hard dependency) ──────────

/** What the barrier sees about the just-completed turn. */
export interface TurnBarrierContext {
  sessionId: string
  turn: number
  messageId: string
  replyText: string
  journeyId?: string
  runId?: string
}

/**
 * Awaited after the SSE `done` of every turn when injected. T1a-6's
 * ProjectionBarrier (or the audit barrier) composes here; the client itself
 * has no oracle dependency.
 */
export type TurnBarrier = (ctx: TurnBarrierContext) => Promise<void>

// ── Options ──────────────────────────────────────────────────────────────────

export interface ChatClientOptions {
  /** SUT api base, e.g. `http://localhost:3001` (test profile, T1a-11b). */
  baseUrl: string
  /**
   * Auth `Cookie` header value for authenticated journeys — produced by the
   * T1a-4 authFixture (`cookieHeader(mintCustomerToken(...))`). Threaded on
   * BOTH the POST and the SSE GET. Omit for guest journeys.
   */
  cookie?: string
  /** Conversation handle. Default: a fresh UUID (the route requires a uuid — chat.ts:53). */
  sessionId?: string
  /** Channel enum value (chat.ts:55). Default: web. */
  channel?: Channel
  /** Fetch implementation (default `globalThis.fetch`) — injectable for tests. */
  fetchImpl?: typeof fetch
  /** Per-turn wall-clock deadline (ms). Default 120_000. */
  turnTimeoutMs?: number
  /**
   * Max SSE GET attempts per turn. A dropped stream is retried — the route
   * replays the turn's buffered chunks (chat.ts:456-464), and each attempt
   * re-accumulates from scratch (idempotent replay handling). Default 3.
   */
  maxStreamAttempts?: number
  /** Optional post-`done` barrier (T1a-6 seam). */
  barrier?: TurnBarrier
  /** Stamped onto chat.turn.* trace events when known. */
  journeyId?: string
  runId?: string
}

// ── SSE line parsing ─────────────────────────────────────────────────────────

/**
 * Parse one SSE line into a StreamChunk, or null for non-data lines
 * (heartbeat comments `: ping` — chat.ts:433 — blank separators, malformed
 * payloads). Same defensive posture as the cli reference (api.ts:160-169).
 */
function parseSseLine(line: string): StreamChunk | null {
  if (!line.startsWith("data: ")) return null
  const payload = line.slice(6).trim()
  if (!payload) return null
  try {
    return JSON.parse(payload) as StreamChunk
  } catch {
    return null
  }
}

interface PostChatResponse {
  messageId: string
  sessionToken?: string
  sessionSecret?: string
}

/** Bounded 409 retry policy for the post-done lock-release race (see #postMessage). */
const POST_LOCK_RETRIES = 5
const POST_LOCK_RETRY_DELAY_MS = 300

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ""
  }
}

// ── ChatClient ───────────────────────────────────────────────────────────────

/**
 * One conversation against the SUT's chat surface. Holds the session
 * credentials the route deals out (guest `sessionSecret`, authed
 * `sessionToken`) and echoes them on every subsequent request — POST *and*
 * SSE GET — which is exactly what the cli reference never did.
 */
export class ChatClient {
  readonly sessionId: string

  readonly #baseUrl: string
  readonly #cookie: string | undefined
  readonly #channel: Channel
  readonly #fetch: typeof fetch
  readonly #turnTimeoutMs: number
  readonly #maxStreamAttempts: number
  readonly #barrier: TurnBarrier | undefined
  readonly #journeyId: string | undefined
  readonly #runId: string | undefined

  #sessionSecret: string | undefined
  #sessionToken: string | undefined
  #turn = 0

  constructor(options: ChatClientOptions) {
    if (!options.baseUrl) {
      throw new ChatClientError("ChatClient: baseUrl is required")
    }
    this.#baseUrl = options.baseUrl.replace(/\/$/, "")
    this.#cookie = options.cookie
    this.#channel = options.channel ?? Channel.Web
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as typeof fetch)
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 120_000
    this.#maxStreamAttempts = options.maxStreamAttempts ?? 3
    this.#barrier = options.barrier
    this.#journeyId = options.journeyId
    this.#runId = options.runId
    this.sessionId = options.sessionId ?? randomUUID()
  }

  /** Guest session secret captured from the FIRST guest POST (chat.ts:211-214). */
  get sessionSecret(): string | undefined {
    return this.#sessionSecret
  }

  /**
   * Signed sessionId↔customerId binding minted on every AUTHENTICATED POST
   * (chat.ts:249-251; format `sessionId.customerId.issuedAt.sig` —
   * @ibatexas/tools signed-claims.ts:63-67). Refreshed each turn.
   */
  get sessionToken(): string | undefined {
    return this.#sessionToken
  }

  /** Turns completed so far (1-based after the first `perTurn`). */
  get turnsCompleted(): number {
    return this.#turn
  }

  /**
   * Headers echoed on EVERY request once captured: the guest secret and the
   * authed session token ride on both the POST and the SSE GET. (The GET only
   * *checks* the secret — chat.ts:388-398 — but the contract pin is symmetric
   * echo, and the route ignores extras.)
   */
  #credentialHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.#cookie !== undefined) headers["cookie"] = this.#cookie
    if (this.#sessionSecret !== undefined) headers["x-session-secret"] = this.#sessionSecret
    if (this.#sessionToken !== undefined) headers["x-session-token"] = this.#sessionToken
    return headers
  }

  /** Build the journey/runId trace fields shared by the chat.turn.* events. */
  #traceFields(): { journey?: string; runId?: string } {
    const fields: { journey?: string; runId?: string } = {}
    if (this.#journeyId !== undefined) fields.journey = this.#journeyId
    if (this.#runId !== undefined) fields.runId = this.#runId
    return fields
  }

  /** Build the journeyId/runId fields for the barrier context. */
  #barrierFields(): { journeyId?: string; runId?: string } {
    const fields: { journeyId?: string; runId?: string } = {}
    if (this.#journeyId !== undefined) fields.journeyId = this.#journeyId
    if (this.#runId !== undefined) fields.runId = this.#runId
    return fields
  }

  /** Emit the `chat.turn.start` trace event for a turn. */
  #emitTurnStart(turn: number): void {
    emitChatTurnStart({
      sessionId: this.sessionId,
      turn,
      ...this.#traceFields(),
    })
  }

  /** Emit the `chat.turn.end` trace event for a turn. */
  #emitTurnEnd(
    turn: number,
    duration: number,
    outcome: "pass" | "fail" | "error",
    detail: string,
  ): void {
    emitChatTurnEnd({
      sessionId: this.sessionId,
      turn,
      duration,
      outcome,
      detail,
      ...this.#traceFields(),
    })
  }

  /** Build the per-turn timeout failure (supersedes the raw cause when the deadline elapsed). */
  #turnTimeoutFailure(): ChatTurnTimeoutError {
    return new ChatTurnTimeoutError(this.sessionId, this.#turnTimeoutMs)
  }

  /** Render a failure into the `chat.turn.end` detail string. */
  #failureDetail(failure: unknown): string {
    return failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)
  }

  /**
   * Run one user turn: POST the message, stream the SSE response to the
   * terminal `done`, await the injected barrier (when any), and return
   * {replyText, sessionId, timings} plus the raw chunks for the trace.
   *
   * Turn completion semantics: the turn is complete at the SSE `done` event
   * (chat.ts:459-463). Replayed/buffered frames are tolerated — every stream
   * attempt re-accumulates from scratch and the FIRST `done` wins.
   */
  async perTurn(message: string): Promise<ChatTurn> {
    const turn = this.#turn + 1
    const startedAt = new Date().toISOString()
    const t0 = Date.now()

    this.#emitTurnStart(turn)

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#turnTimeoutMs)
    // Don't let a lone turn timer keep the test process alive.
    ;(timer as { unref?: () => void }).unref?.()

    try {
      // ── 1. POST the user message ────────────────────────────────────────
      const messageId = await this.#postMessage(message, controller.signal)
      const postMs = Date.now() - t0

      // ── 2. Stream to `done` (replay-tolerant) ───────────────────────────
      const streamStart = Date.now()
      const { replyText, events, inputTokens, outputTokens } = await this.#streamTurn(
        controller.signal,
      )
      const streamMs = Date.now() - streamStart

      // ── 3. Optional audit/projection barrier (T1a-6 seam) ───────────────
      let barrierMs: number | undefined
      if (this.#barrier !== undefined) {
        const barrierStart = Date.now()
        await this.#barrier({
          sessionId: this.sessionId,
          turn,
          messageId,
          replyText,
          ...this.#barrierFields(),
        })
        barrierMs = Date.now() - barrierStart
      }

      const totalMs = Date.now() - t0
      this.#turn = turn

      const detail =
        `post=${postMs}ms stream=${streamMs}ms` +
        (barrierMs === undefined ? "" : ` barrier=${barrierMs}ms`)
      this.#emitTurnEnd(turn, totalMs, "pass", detail)

      return {
        turn,
        sessionId: this.sessionId,
        messageId,
        replyText,
        events,
        timings: {
          startedAt,
          postMs,
          streamMs,
          ...(barrierMs === undefined ? {} : { barrierMs }),
          totalMs,
        },
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      }
    } catch (err) {
      // A timeout error supersedes the raw cause when the deadline elapsed.
      const failure = timedOut ? this.#turnTimeoutFailure() : err
      this.#emitTurnEnd(turn, Date.now() - t0, "error", this.#failureDetail(failure))
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  // ── POST /api/chat/messages ────────────────────────────────────────────────

  async #postMessage(message: string, signal: AbortSignal): Promise<string> {
    let res: Awaited<ReturnType<typeof fetch>> | undefined

    // 409 ("Aguarde a resposta anterior.", chat.ts:221-229) is retried with a
    // short backoff: the previous turn's lock is released AFTER its `done`
    // chunk is pushed (chat.ts:307 vs :316-324), so a prompt next-turn POST
    // can race the release. Bounded — anything still locked after the
    // retries is a genuine concurrent turn and surfaces as ChatHttpError.
    for (let attempt = 1; attempt <= POST_LOCK_RETRIES; attempt++) {
      res = await this.#fetch(`${this.#baseUrl}/api/chat/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.#credentialHeaders(),
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
          message,
          channel: this.#channel,
        }),
        signal,
      })
      if (res.status !== 409 || attempt === POST_LOCK_RETRIES) break
      await new Promise((r) => setTimeout(r, POST_LOCK_RETRY_DELAY_MS))
    }

    if (!res?.ok) {
      throw new ChatHttpError(
        "POST /api/chat/messages",
        res?.status ?? 0,
        res === undefined ? "" : await safeText(res),
      )
    }

    const body = (await res.json()) as PostChatResponse

    // Capture the dealt credentials for ALL subsequent requests:
    //   sessionSecret — minted once on the first guest POST (chat.ts:211-214);
    //   sessionToken  — minted on every authed POST (chat.ts:249-251), so the
    //                   freshest one always wins.
    if (typeof body.sessionSecret === "string" && body.sessionSecret !== "") {
      this.#sessionSecret = body.sessionSecret
    }
    if (typeof body.sessionToken === "string" && body.sessionToken !== "") {
      this.#sessionToken = body.sessionToken
    }

    return body.messageId
  }

  // ── GET /api/chat/stream/:sessionId (SSE) ─────────────────────────────────

  async #streamTurn(signal: AbortSignal): Promise<{
    replyText: string
    events: ChatTraceEvent[]
    inputTokens?: number
    outputTokens?: number
  }> {
    const events: ChatTraceEvent[] = []

    for (let attempt = 1; attempt <= this.#maxStreamAttempts; attempt++) {
      const outcome = await this.#streamOnce(attempt, events, signal)
      if (outcome !== undefined) return { ...outcome, events }
      // Stream ended without a terminal chunk (drop / half-close). Retry: the
      // route replays the buffered chunks from the start of the turn
      // (chat.ts:456-464); #streamOnce re-accumulates from scratch, so the
      // replay is idempotent by construction.
    }

    throw new ChatStreamIncompleteError(this.sessionId, this.#maxStreamAttempts)
  }

  /** Build the completed-turn result from a `done` chunk (token fields optional). */
  #doneResult(
    chunk: { inputTokens?: number; outputTokens?: number },
    replyText: string,
  ): { replyText: string; inputTokens?: number; outputTokens?: number } {
    const result: { replyText: string; inputTokens?: number; outputTokens?: number } = {
      replyText,
    }
    if (chunk.inputTokens !== undefined) result.inputTokens = chunk.inputTokens
    if (chunk.outputTokens !== undefined) result.outputTokens = chunk.outputTokens
    return result
  }

  /**
   * One SSE connection. Returns the completed turn on `done`, throws on an
   * `error` chunk, and returns `undefined` when the stream ends without a
   * terminal chunk (caller retries). Frames are appended to `events` (trace),
   * tagged with the attempt number.
   */
  async #streamOnce(
    attempt: number,
    events: ChatTraceEvent[],
    signal: AbortSignal,
  ): Promise<{ replyText: string; inputTokens?: number; outputTokens?: number } | undefined> {
    const res = await this.#fetch(
      `${this.#baseUrl}/api/chat/stream/${this.sessionId}`,
      {
        headers: {
          accept: "text/event-stream",
          ...this.#credentialHeaders(),
        },
        signal,
      },
    )

    // The hijacked route answers 200 even for its in-band error events; a
    // non-2xx here is the fail-closed 503 (chat.ts:402) or a gateway problem.
    if (!res.ok || !res.body) {
      throw new ChatHttpError("GET /api/chat/stream", res.status, await safeText(res))
    }

    // Idempotent replay handling: the accumulator is LOCAL to the attempt, so
    // replayed deltas after a reconnect never double-count.
    let replyText = ""

    const decoder = new TextDecoder()
    let buf = ""

    for await (const raw of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(raw, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""

      for (const line of lines) {
        const chunk = parseSseLine(line)
        if (chunk === null) continue
        events.push({ attempt, at: new Date().toISOString(), chunk })

        if (chunk.type === "text_delta") {
          replyText += chunk.delta
        } else if (chunk.type === "done") {
          // Turn complete (chat.ts:459-463). The route ends the stream here;
          // we stop reading immediately so any buffered post-done frames from
          // a replaying intermediary are ignored (first `done` wins).
          return this.#doneResult(chunk, replyText)
        } else if (chunk.type === "error") {
          throw new ChatStreamError(this.sessionId, chunk.message)
        }
        // tool_start / tool_result / pix_data / status / kernel_done frames
        // are trace-only for the client (the StreamChunk union — agent.types).
      }
    }

    // Ended without a terminal chunk — signal the caller to retry.
    return undefined
  }
}
