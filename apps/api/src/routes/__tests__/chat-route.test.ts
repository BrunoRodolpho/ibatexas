// Coverage for routes/chat.ts — the thin delegate over the @claustrum Conductor.
//
// We exercise the real route handlers (built into an isolated Fastify app and
// driven via inject) with every external collaborator mocked: Redis, the
// session store, the streaming emitter, the execution-queue lock, the Conductor
// bootstrap, the bot-pause gate, and handleTurn. NO real LLM, DB, Redis or NATS.
//
// What this pins down (behaviour, not lines):
//   POST /api/chat/messages
//     - guest first-contact mints a session secret (echoed in the body)
//     - guest replay with a wrong secret → 403 (pt-BR)
//     - authenticated owner-token mismatch → 403; foreign owner → 403
//     - happy authenticated path returns a session token
//     - busy session (lock not acquired) → 409
//     - zod body validation → 400
//     - fire-and-forget runConductorTurn: normal turn (text_delta + done +
//       assistant persistence + capsule close + cleanup + lock release),
//       bot-paused short-circuit, handleTurn failure → error chunk, empty reply.
//   GET /api/chat/stream/:sessionId (hijacked SSE)
//     - CORS allowlist header is reflected only for an allowed Origin
//     - authenticated non-owner / guest secret-mismatch → "Acesso negado." frame
//     - Redis failure → fail-closed 503 frame
//     - same-replica replay of a terminated buffer
//     - same-replica live delivery off the EventEmitter
//     - cross-replica delivery via subscribeToStream

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
// EGRESS BRAND (E-1): a text_delta StreamChunk carries a branded RenderedReply
// in memory; the SSE chokepoint (chunkToWire) unwraps it. Mint both the chunks
// the route emits (assertions) and the chunks fed into the stream (mock data).
import { mintRenderedReply } from "@adjudicate/core";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockRedisGet = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockCreateSessionToken = vi.hoisted(() => vi.fn());
const mockVerifySessionToken = vi.hoisted(() => vi.fn());

const mockHandleTurn = vi.hoisted(() => vi.fn());
const mockGetConductor = vi.hoisted(() => vi.fn());
const mockOpenCapsule = vi.hoisted(() => vi.fn());
const mockCloseCapsule = vi.hoisted(() => vi.fn());

const mockLoadSession = vi.hoisted(() => vi.fn());
const mockAppendMessages = vi.hoisted(() => vi.fn());

const mockCreateStream = vi.hoisted(() => vi.fn());
const mockPushChunk = vi.hoisted(() => vi.fn());
const mockGetStream = vi.hoisted(() => vi.fn());
const mockSubscribeToStream = vi.hoisted(() => vi.fn());
const mockCleanupStream = vi.hoisted(() => vi.fn());

const mockAcquireLock = vi.hoisted(() => vi.fn());
const mockReleaseLock = vi.hoisted(() => vi.fn());

const mockIsSessionPausedForHuman = vi.hoisted(() => vi.fn());

// W1 no-reply seam: keep the PURE classifier real (it maps disposition → cause),
// mock ONLY the two side-effecting collaborators (NATS emit + governed open) so
// the route's classify→open→fallback ordering is exercised end-to-end without a
// real kernel/NATS/DB.
const mockEmitNoDelivery = vi.hoisted(() => vi.fn());
const mockOpenIncidentInline = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: (k: string) => `ibatexas:${k}`,
  createSessionToken: mockCreateSessionToken,
  verifySessionToken: mockVerifySessionToken,
}));

vi.mock("@claustrum/core", () => ({
  handleTurn: mockHandleTurn,
}));

vi.mock("../../middleware/auth.js", () => ({
  // Per-request synthetic auth: an `x-test-customer-id` header authenticates.
  optionalAuth: (
    request: { headers: Record<string, string>; customerId?: string },
    _reply: unknown,
    done: () => void,
  ) => {
    const cid = request.headers["x-test-customer-id"];
    if (cid) request.customerId = cid;
    done();
  },
}));

vi.mock("../../session/store.js", () => ({
  loadSession: mockLoadSession,
  appendMessages: mockAppendMessages,
}));

vi.mock("../../streaming/emitter.js", () => ({
  createStream: mockCreateStream,
  pushChunk: mockPushChunk,
  getStream: mockGetStream,
  subscribeToStream: mockSubscribeToStream,
  cleanupStream: mockCleanupStream,
  // EGRESS BRAND (E-1): the SSE chokepoint extracts the branded text_delta
  // payload to a plain string for the wire.
  chunkToWire: (chunk: { type: string; delta?: { text: string } }) =>
    chunk.type === "text_delta"
      ? { type: "text_delta", delta: chunk.delta?.text }
      : chunk,
}));

vi.mock("../../streaming/execution-queue.js", () => ({
  acquireWebAgentLock: mockAcquireLock,
  releaseWebAgentLock: mockReleaseLock,
}));

vi.mock("../../claustrum-bootstrap.js", () => ({
  getConductor: mockGetConductor,
}));

vi.mock("../../escalation/escalation-store.js", () => ({
  isSessionPausedForHuman: mockIsSessionPausedForHuman,
}));

vi.mock("../../conversation/no-delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../conversation/no-delivery.js")>();
  return {
    ...actual, // keep classifyTurnDelivery (pure) + the types
    emitNoDelivery: mockEmitNoDelivery,
    openIncidentInline: mockOpenIncidentInline,
  };
});

import { chatRoutes } from "../chat.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const SID = "11111111-1111-4111-8111-111111111111";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(chatRoutes);
  await app.ready();
  return app;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

function assistantWasPersisted(): boolean {
  return mockAppendMessages.mock.calls.some(
    (c) => Array.isArray(c[1]) && c[1][0]?.role === "assistant",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CORS_ORIGIN", "");
  vi.stubEnv("SSE_HEARTBEAT_MS", "0"); // disable the keep-alive interval by default

  mockGetRedisClient.mockResolvedValue({ get: mockRedisGet, set: mockRedisSet });
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue("OK");

  mockCreateSessionToken.mockReturnValue("session-token-xyz");
  mockVerifySessionToken.mockReturnValue(null);

  mockLoadSession.mockResolvedValue([]);
  mockAppendMessages.mockResolvedValue(undefined);

  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);

  mockIsSessionPausedForHuman.mockResolvedValue(false);

  mockOpenCapsule.mockResolvedValue({ id: "capsule-1", turnId: "turn-1" });
  mockCloseCapsule.mockResolvedValue(undefined);
  mockGetConductor.mockReturnValue({
    openCapsule: mockOpenCapsule,
    closeCapsule: mockCloseCapsule,
  });
  // Default turn yields a deliverable assistant reply.
  mockHandleTurn.mockResolvedValue({
    response: { text: "Olá! Como posso ajudar?" },
    decision: { kind: "EXECUTE" },
  });

  mockEmitNoDelivery.mockResolvedValue(undefined);
  mockOpenIncidentInline.mockResolvedValue({ kind: "opened", incidentId: "inc-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── POST /api/chat/messages ─────────────────────────────────────────────────

describe("POST /api/chat/messages — auth, ownership & lock guards", () => {
  it("guest first contact: 200 + a freshly minted session secret", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.sessionSecret).toBe("string"); // minted because none existed
    expect(body.sessionToken).toBeUndefined(); // guests get no JWT
    // Secret was persisted with a 1h TTL.
    expect(mockRedisSet).toHaveBeenCalledWith(
      "ibatexas:session:secret:" + SID,
      expect.any(String),
      { EX: 3600 },
    );
    await app.close();
  });

  it("guest replay with a wrong secret → 403 (pt-BR)", async () => {
    mockRedisGet.mockResolvedValue("the-real-secret"); // a secret already exists
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { "x-session-secret": "wrong" },
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Segredo de sessão inválido.");
    // Guard fired before the lock was ever taken.
    expect(mockAcquireLock).not.toHaveBeenCalled();
    await app.close();
  });

  it("guest replay with the matching secret → 200 and NO new secret", async () => {
    mockRedisGet.mockResolvedValue("the-real-secret");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { "x-session-secret": "the-real-secret" },
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sessionSecret).toBeUndefined();
    await app.close();
  });

  it("authenticated owner: 200 + a session token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { "x-test-customer-id": "cust_A" },
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sessionToken).toBe("session-token-xyz");
    expect(res.json().sessionSecret).toBeUndefined(); // not a guest
    // Owner key re-asserted with a 24h TTL.
    expect(mockRedisSet).toHaveBeenCalledWith(
      "ibatexas:session:owner:" + SID,
      "cust_A",
      { EX: 86400 },
    );
    await app.close();
  });

  it("authenticated with a mismatched session token → 403", async () => {
    mockVerifySessionToken.mockReturnValue({ sessionId: "other-session", customerId: "cust_A" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { "x-test-customer-id": "cust_A", "x-session-token": "tampered" },
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Token de sessão inválido.");
    await app.close();
  });

  it("authenticated but the session is owned by someone else → 403", async () => {
    mockRedisGet.mockResolvedValue("cust_B"); // existing owner differs
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { "x-test-customer-id": "cust_A" },
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Sessão pertence a outro usuário.");
    await app.close();
  });

  it("session already running (lock not acquired) → 409", async () => {
    mockAcquireLock.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("Aguarde a resposta anterior.");
    await app.close();
  });

  it("rejects an empty message via the zod body schema → 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "", channel: "web" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an unknown channel via the zod body schema → 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "oi", channel: "carrier-pigeon" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ── POST → fire-and-forget runConductorTurn delivery ────────────────────────

describe("POST /api/chat/messages — Conductor turn delivery (fire-and-forget)", () => {
  async function postGuest(message = "oi"): Promise<void> {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message, channel: "web" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  }

  it("normal turn: pushes text_delta + done, persists the assistant reply, closes the capsule, releases the lock", async () => {
    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockIsSessionPausedForHuman).toHaveBeenCalledWith(SID);
    expect(mockGetConductor).toHaveBeenCalledTimes(1);
    expect(mockOpenCapsule).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "web", sessionKey: SID }),
    );
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);

    expect(mockPushChunk).toHaveBeenCalledWith(SID, {
      type: "text_delta",
      delta: mintRenderedReply("Olá! Como posso ajudar?"),
    });
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });

    expect(assistantWasPersisted()).toBe(true);
    expect(mockCloseCapsule).toHaveBeenCalledWith({ id: "capsule-1", turnId: "turn-1" });
    expect(mockCleanupStream).toHaveBeenCalledWith(SID);
  });

  it("bot-paused session: emits only `done` and never runs the Conductor", async () => {
    mockIsSessionPausedForHuman.mockResolvedValue(true);
    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
    expect(mockGetConductor).not.toHaveBeenCalled();
    expect(mockHandleTurn).not.toHaveBeenCalled();
    expect(assistantWasPersisted()).toBe(false);
    // Finally-block cleanup still runs.
    expect(mockCleanupStream).toHaveBeenCalledWith(SID);
  });

  it("handleTurn failure: emits an error chunk, still closes the capsule and releases the lock", async () => {
    mockHandleTurn.mockRejectedValue(new Error("planner exploded"));
    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "error", message: "Erro interno." });
    // The inner try/finally closed the capsule before the error propagated.
    expect(mockCloseCapsule).toHaveBeenCalledTimes(1);
    expect(assistantWasPersisted()).toBe(false);
  });

  it("empty assistant reply: emits `done` only, no assistant persistence", async () => {
    mockHandleTurn.mockResolvedValue({ response: { text: "" } });
    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
    expect(mockPushChunk).not.toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ type: "text_delta" }),
    );
    expect(assistantWasPersisted()).toBe(false);
  });
});

// ── W1 no-reply seam (web/chat plane, P1-9) ─────────────────────────────────
// The web analog of the WhatsApp empty/failure substitution: a genuine drop
// (empty / whitespace / aborted-without-delivery) opens a governed incident via
// the SHARED conversation/no-delivery.ts machinery, and a flag-gated pt-BR
// holding chunk replaces the bare `{type:"done"}`. A delivered reply, the
// intentional bot-pause, and an ESCALATE handoff are never incidents.
describe("POST /api/chat/messages — W1 no-reply incident seam", () => {
  async function postGuest(message = "oi"): Promise<void> {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message, channel: "web" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  }

  it("empty completion: opens an `empty_completion` web incident and (flag on) pushes a pt-BR holding chunk before `done`", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "true");
    mockHandleTurn.mockResolvedValue({ response: { text: "" }, decision: { kind: "EXECUTE" } });

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    // Notification fan-out + durable governed open, both keyed on the web turn.
    expect(mockEmitNoDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "empty_completion", channel: "web", sessionId: SID }),
      expect.anything(),
    );
    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "empty_completion",
        channel: "web",
        customerImpacted: true,
        senderRef: `web:${SID}`,
        turnId: "turn-1",
        messageSid: expect.stringMatching(/^[0-9a-f-]{36}$/), // messageId fallback
      }),
      expect.anything(),
    );

    // Customer harm-reducer: a pt-BR holding chunk, THEN the terminal done.
    expect(mockPushChunk).toHaveBeenCalledWith(SID, {
      type: "text_delta",
      delta: expect.objectContaining({
        text: expect.stringContaining("não consegui montar uma resposta"),
      }),
    });
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
    // The model never produced a usable reply → nothing persisted as assistant.
    expect(assistantWasPersisted()).toBe(false);
  });

  it("whitespace-only completion: opens a `whitespace_only` incident (flag off → no holding chunk)", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "false");
    mockHandleTurn.mockResolvedValue({ response: { text: "   \n  " }, decision: { kind: "EXECUTE" } });

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "whitespace_only", channel: "web" }),
      expect.anything(),
    );
    // Flag off → bare done, no holding chunk, no text_delta at all.
    expect(mockPushChunk).not.toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ type: "text_delta" }),
    );
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
  });

  it("deliverable reply: NO incident, NO holding chunk, delivers + persists normally", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "true");
    mockHandleTurn.mockResolvedValue({
      response: { text: "Pedido confirmado!" },
      decision: { kind: "EXECUTE" },
    });

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockEmitNoDelivery).not.toHaveBeenCalled();
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    expect(mockPushChunk).toHaveBeenCalledWith(SID, {
      type: "text_delta",
      delta: mintRenderedReply("Pedido confirmado!"),
    });
    expect(assistantWasPersisted()).toBe(true);
  });

  it("bot-paused session: NO incident (pause is excluded by construction)", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "true");
    mockIsSessionPausedForHuman.mockResolvedValue(true);

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    expect(mockEmitNoDelivery).not.toHaveBeenCalled();
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
  });

  it("ESCALATE handoff with empty text: NO incident, NO holding chunk (deliberate yield to a human)", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "true");
    mockHandleTurn.mockResolvedValue({ response: { text: "" }, decision: { kind: "ESCALATE" } });

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    expect(mockPushChunk).not.toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ type: "text_delta" }),
    );
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
  });
});

// ── W1 seam — supersession (F1) & conductor-throw catch parity (F2) ──────────
// F1: `turnAbort.signal.aborted` is set by BOTH a genuine SSE client-disconnect
// AND a newer turn superseding this one. Only a STILL-CURRENT aborted turn (the
// registry slot is still ours) is a real drop; a superseded turn (a successor
// took the slot and will answer) must open NO incident.
// F2: a conductor/handleTurn THROW skipped the inner classify; the catch must
// open a governed incident (WhatsApp :899 parity) rather than only pushing a
// bare {type:error}.
describe("POST /api/chat/messages — W1 supersession (F1) & catch parity (F2)", () => {
  it("F1: a superseded turn (a newer turn arrived for the same session) opens NO incident", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "true");

    // Turn A hangs until released and (if it were still current) would be an
    // empty-completion drop. Turn B arrives first, supersedes A (aborts its
    // controller + takes the registry slot), and answers deliverably.
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    mockHandleTurn
      .mockImplementationOnce(async () => {
        await gateA;
        return { response: { text: "" }, decision: { kind: "EXECUTE" } }; // empty → would-be drop
      })
      .mockResolvedValueOnce({
        response: { text: "Resposta da segunda mensagem." },
        decision: { kind: "EXECUTE" },
      });

    const app = await buildApp();

    // POST A — fire-and-forget turn hangs on gateA.
    await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "A", channel: "web" },
    });
    await waitFor(() => mockHandleTurn.mock.calls.length === 1);

    // POST B — supersedes A (previous?.abort()) and resolves deliverably.
    await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "B", channel: "web" },
    });
    await waitFor(() => mockHandleTurn.mock.calls.length === 2);
    await waitFor(() => mockReleaseLock.mock.calls.length >= 1); // B completed

    // Now release A — it resolves aborted + NO-LONGER-CURRENT (superseded).
    releaseA();
    await waitFor(() => mockReleaseLock.mock.calls.length >= 2);

    // A was superseded → suppressed like a bot-pause: no incident at all.
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    expect(mockEmitNoDelivery).not.toHaveBeenCalled();
    // B delivered its reply; A (superseded) delivered nothing of its own.
    expect(mockPushChunk).toHaveBeenCalledWith(SID, {
      type: "text_delta",
      delta: mintRenderedReply("Resposta da segunda mensagem."),
    });
    await app.close();
  });

  it("F1: a genuine client-disconnect while still-current + nothing delivered → timeout incident (customerImpacted)", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "false");

    // The turn would be deliverable, but the SSE client disconnects before it
    // resolves, so nothing reaches the customer — a genuine timeout-class drop.
    let releaseTurn!: () => void;
    const gate = new Promise<void>((r) => {
      releaseTurn = r;
    });
    mockHandleTurn.mockImplementation(async () => {
      await gate;
      return { response: { text: "resposta tardia" }, decision: { kind: "EXECUTE" } };
    });

    // Serve the GET off a local stream that never terminates, so the consumer's
    // request "close" (driven by the abort below) lands while UNFINISHED →
    // abortTurnOnDisconnect aborts the STILL-CURRENT producing turn.
    const emitter = new EventEmitter();
    mockGetStream.mockReturnValue({ emitter, buffer: [], seq: 0 });

    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });
    await waitFor(() => mockHandleTurn.mock.calls.length === 1);

    // Open the SSE stream, then disconnect it via an AbortSignal once subscribed.
    const ac = new AbortController();
    const getPromise = app
      .inject({ method: "GET", url: `/api/chat/stream/${SID}`, signal: ac.signal })
      .catch(() => undefined); // a client disconnect rejects the inject — expected
    await waitFor(() => emitter.listenerCount("chunk") > 0);
    ac.abort(); // disconnect → request "close" → abortTurnOnDisconnect() (still current)
    // The close handler removes the chunk listener as it aborts the turn.
    await waitFor(() => emitter.listenerCount("chunk") === 0);

    // Release the turn: it resolves aborted, still-current, with nothing delivered.
    releaseTurn();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);
    await getPromise;

    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "timeout",
        customerImpacted: true,
        channel: "web",
        sessionId: SID,
        turnId: "turn-1",
      }),
      expect.anything(),
    );
    // Aborted client → nothing was delivered to it.
    expect(mockPushChunk).not.toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ type: "text_delta" }),
    );
    expect(mockPushChunk).not.toHaveBeenCalledWith(SID, { type: "done" });
    await app.close();
  });

  it("F2: the conductor throws → opens an incident (send_failed, customerImpacted=false) + degraded {type:error} — WA :899 parity", async () => {
    mockHandleTurn.mockRejectedValue(new Error("conductor exploded"));

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    // The throw is covered: emit + governed open, keyed on the web messageId
    // (no turnId is in scope on the catch path), customerImpacted=false because
    // the degraded {type:error} reached the still-connected client.
    expect(mockEmitNoDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "send_failed", channel: "web", customerImpacted: false }),
      expect.anything(),
    );
    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "send_failed",
        customerImpacted: false,
        channel: "web",
        sessionId: SID,
        senderRef: `web:${SID}`,
        turnId: null, // catch path has no turnId — dedup falls back to messageId
        messageSid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
      expect.anything(),
    );

    // Degraded delivery still reached the client; nothing was persisted.
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "error", message: "Erro interno." });
    expect(assistantWasPersisted()).toBe(false);
    expect(mockCloseCapsule).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("F2: a post-result throw (closeCapsule after a delivered reply) does NOT open a false incident", async () => {
    // A normal deliverable turn, but capsule close fails AFTER the reply was
    // delivered + classified. The inner path already owned the (no-)incident
    // decision, so the catch must not double-open.
    mockHandleTurn.mockResolvedValue({
      response: { text: "Tudo certo!" },
      decision: { kind: "EXECUTE" },
    });
    mockCloseCapsule.mockRejectedValue(new Error("capsule close failed"));

    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    // Reply was delivered → no drop, no incident despite the post-delivery throw.
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    expect(mockEmitNoDelivery).not.toHaveBeenCalled();
    expect(mockPushChunk).toHaveBeenCalledWith(SID, {
      type: "text_delta",
      delta: mintRenderedReply("Tudo certo!"),
    });
    await app.close();
  });
});

// ── GET /api/chat/stream/:sessionId (hijacked SSE) ──────────────────────────

describe("GET /api/chat/stream/:sessionId — access guards", () => {
  it("authenticated non-owner is denied with an SSE error frame", async () => {
    mockRedisGet.mockResolvedValue("cust_owner"); // owner key
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${SID}`,
      headers: { "x-test-customer-id": "cust_intruder" },
    });

    expect(res.payload).toContain('"type":"error"');
    expect(res.payload).toContain("Acesso negado.");
    expect(mockGetStream).not.toHaveBeenCalled(); // rejected before serving
    await app.close();
  });

  it("guest with a wrong secret is denied with an SSE error frame", async () => {
    mockRedisGet.mockResolvedValue("real-secret"); // secret key exists
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${SID}`,
      headers: { "x-session-secret": "nope" },
    });

    expect(res.payload).toContain("Acesso negado.");
    await app.close();
  });

  it("fails closed with a 503 frame when the Redis ownership check throws", async () => {
    mockRedisGet.mockRejectedValue(new Error("redis down"));
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${SID}`,
      headers: { "x-test-customer-id": "cust_A" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.payload).toContain("Erro temporario. Tente novamente.");
    await app.close();
  });
});

describe("GET /api/chat/stream/:sessionId — chunk delivery", () => {
  it("same-replica: replays a buffer that already terminated, with CORS for an allowed Origin", async () => {
    vi.stubEnv("SSE_HEARTBEAT_MS", "15000"); // exercise the keep-alive interval branch
    mockRedisGet.mockResolvedValue(null); // guest, no secret → falls through to serving
    mockGetStream.mockReturnValue({
      emitter: new EventEmitter(),
      buffer: [
        { type: "text_delta", delta: mintRenderedReply("parcial") },
        { type: "done" },
      ],
      seq: 2,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${SID}`,
      headers: { origin: "http://localhost:5173" },
    });

    expect(res.payload).toContain('data: {"type":"text_delta","delta":"parcial"}');
    expect(res.payload).toContain('data: {"type":"done"}');
    // CORS allowlist reflected the dev-LAN Origin.
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["content-type"]).toContain("text/event-stream");
    await app.close();
  });

  it("same-replica: streams live chunks off the EventEmitter until the terminal `done`", async () => {
    mockRedisGet.mockResolvedValue(null);
    const emitter = new EventEmitter();
    mockGetStream.mockReturnValue({ emitter, buffer: [], seq: 0 });

    const app = await buildApp();
    const injectPromise = app.inject({
      method: "GET",
      url: `/api/chat/stream/${SID}`,
    });

    // Wait until the handler has subscribed, then push live chunks.
    await waitFor(() => emitter.listenerCount("chunk") > 0);
    emitter.emit("chunk", { type: "text_delta", delta: mintRenderedReply("ao-vivo") });
    emitter.emit("chunk", { type: "done" });

    const res = await injectPromise;
    expect(res.payload).toContain('"delta":"ao-vivo"');
    expect(res.payload).toContain('"type":"done"');
    await app.close();
  });

  it("cross-replica: delivers via subscribeToStream and closes the subscription", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetStream.mockReturnValue(undefined); // no local entry → Redis path
    const close = vi.fn().mockResolvedValue(undefined);
    mockSubscribeToStream.mockImplementation(
      async (_sid: string, onChunk: (c: unknown) => void) => {
        onChunk({ type: "text_delta", delta: mintRenderedReply("via-redis") });
        onChunk({ type: "done" });
        return { close };
      },
    );

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${SID}`,
    });

    expect(mockSubscribeToStream).toHaveBeenCalledWith(SID, expect.any(Function));
    expect(res.payload).toContain('"delta":"via-redis"');
    expect(res.payload).toContain('"type":"done"');
    expect(close).toHaveBeenCalled();
    await app.close();
  });
});
