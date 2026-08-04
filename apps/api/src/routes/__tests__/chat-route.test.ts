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
//       bot-paused short-circuit, handleTurn failure → BKL-168 incident + honest
//       pt-BR fallback frame (never a bare error), empty reply.
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
// W1 Redis-outage fix: the gate now reads the store via readPauseState (real) →
// getEscalationStore().isPaused(), so it DISTINGUISHES a genuine pause from a
// Redis read-error.
const mockIsPaused = vi.hoisted(() => vi.fn());
const mockGetEscalationStore = vi.hoisted(() => vi.fn());

// W1 no-reply seam: keep the PURE classifier real (it maps disposition → cause),
// mock ONLY the two side-effecting collaborators (NATS emit + governed open) so
// the route's classify→open→fallback ordering is exercised end-to-end without a
// real kernel/NATS/DB.
const mockEmitNoDelivery = vi.hoisted(() => vi.fn());
const mockOpenIncidentInline = vi.hoisted(() => vi.fn());
// W1 auto-close seam (M4): a delivered web reply self-heals an OPEN incident.
const mockCloseIncidentOnDeliveredReply = vi.hoisted(() => vi.fn());

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
  getEscalationStore: mockGetEscalationStore,
}));

vi.mock("../../conversation/no-delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../conversation/no-delivery.js")>();
  return {
    ...actual, // keep classifyTurnDelivery (pure) + the types
    emitNoDelivery: mockEmitNoDelivery,
    openIncidentInline: mockOpenIncidentInline,
  };
});

vi.mock("../../incidents/incident-auto-close.js", () => ({
  closeIncidentOnDeliveredReply: mockCloseIncidentOnDeliveredReply,
}));

import { chatRoutes } from "../chat.js";
// R4-S2 — the per-turn ambient contexts, read through their OWN APIs so the probes
// below observe what the real route actually established (none of these three
// modules is mocked in this suite).
import { funnelTurnContext } from "../../claustrum/funnel-tier.js";
import {
  captureWireExchange,
  claimWireExchanges,
  sealWireCall,
} from "../../claustrum/wire-capture.js";
import {
  currentWorkflowChannel,
  currentWorkflowTurnId,
} from "../../claustrum/workflow/workflow-turn.js";

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
  mockIsPaused.mockResolvedValue(false);
  mockGetEscalationStore.mockResolvedValue({ isPaused: mockIsPaused });

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
  mockCloseIncidentOnDeliveredReply.mockResolvedValue(undefined);
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

    expect(mockIsPaused).toHaveBeenCalledWith(SID);
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
    mockIsPaused.mockResolvedValue(true);
    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
    expect(mockGetConductor).not.toHaveBeenCalled();
    expect(mockHandleTurn).not.toHaveBeenCalled();
    expect(assistantWasPersisted()).toBe(false);
    // Finally-block cleanup still runs.
    expect(mockCleanupStream).toHaveBeenCalledWith(SID);
  });

  it("handleTurn failure: opens a governed incident + delivers an honest pt-BR fallback (BKL-168), still closes the capsule and releases the lock", async () => {
    mockHandleTurn.mockRejectedValue(new Error("planner exploded"));
    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);
    await waitFor(() => mockOpenIncidentInline.mock.calls.length > 0);

    // BKL-168 — an escaped handleTurn throw is now a governed no-reply incident
    // (send_failed, customer-impacted) + an honest deterministic pt-BR fallback frame
    // (text_delta + done), NEVER the bare {type:error} void.
    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "send_failed",
        channel: "web",
        customerImpacted: true,
        sessionId: SID,
      }),
      expect.anything(),
    );
    const types = mockPushChunk.mock.calls.map(([, c]) => (c as { type: string }).type);
    expect(types).toContain("text_delta");
    expect(types).toContain("done");
    expect(types).not.toContain("error");
    const fallback = mockPushChunk.mock.calls
      .map(([, c]) => c as { type: string; delta?: { text?: string } })
      .find((c) => c.type === "text_delta");
    expect(fallback?.delta?.text).toContain("não consegui montar uma resposta");
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

  it("M4: a delivered web reply auto-closes an OPEN incident (WhatsApp :1009 parity)", async () => {
    mockHandleTurn.mockResolvedValue({
      response: { text: "Pronto, resolvido!" },
      decision: { kind: "EXECUTE" },
    });

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    // The web plane now self-heals its own OPEN incidents on a delivered reply,
    // keyed on the per-turn id from the capsule (the WhatsApp seam analog).
    expect(mockCloseIncidentOnDeliveredReply).toHaveBeenCalledWith(
      SID,
      "turn-1",
      expect.anything(),
    );
    // A delivered reply is not a drop → no incident opened.
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
  });

  it("M4: an empty (undelivered) web reply does NOT auto-close", async () => {
    mockHandleTurn.mockResolvedValue({ response: { text: "" }, decision: { kind: "EXECUTE" } });

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    // Nothing reached the customer → no self-heal (the drop stays flagged).
    expect(mockCloseIncidentOnDeliveredReply).not.toHaveBeenCalled();
  });

  it("bot-paused session: NO incident (pause is excluded by construction)", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "true");
    mockIsPaused.mockResolvedValue(true);

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    expect(mockEmitNoDelivery).not.toHaveBeenCalled();
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
  });

  it("#2: a pause-gate READ-ERROR opens a pause_read_error web incident (Redis-free) + emits only done", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "true");
    // The bot-pause gate is unreachable (Redis down). Fail-CLOSED (no reply), but
    // a customer-impacted ghost WITHOUT a confirmed pause → a durable
    // pause_read_error incident opens via the inline (Redis-free) path.
    mockGetEscalationStore.mockRejectedValue(new Error("redis down"));

    await postGuest();
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);

    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "pause_read_error",
        customerImpacted: true,
        channel: "web",
        sessionId: SID,
      }),
      expect.anything(),
    );
    // Fail-CLOSED: the conductor never ran; the client just gets a terminal done.
    expect(mockGetConductor).not.toHaveBeenCalled();
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

  it("#6: a genuine client-disconnect (still-current) opens NO incident — routine user behavior, not a delivery failure", async () => {
    vi.stubEnv("WEB_EMPTY_COMPLETION_HOLDING", "false");

    // The turn would be deliverable, but the SSE client disconnects before it
    // resolves. A tab-close / backgrounding is routine user behavior — nobody is
    // waiting — so it must NOT open a governed incident + staff ping (the old
    // over-eager P0-2 web analog). A web SSE turn has no wall-clock deadline, so
    // every abort is a client-close (or a supersession); neither is a ghost.
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

    // #6: a client disconnect is NOT a delivery failure → NO incident, NO ping.
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    expect(mockEmitNoDelivery).not.toHaveBeenCalled();
    // Aborted client → nothing was delivered to it.
    expect(mockPushChunk).not.toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ type: "text_delta" }),
    );
    expect(mockPushChunk).not.toHaveBeenCalledWith(SID, { type: "done" });
    await app.close();
  });

  it("BKL-168: a pre-result internal throw (turn_error) opens a send_failed incident + an honest pt-BR fallback (never a bare error)", async () => {
    // BKL-168 (the never-silent backstop) DELIBERATELY reverses the old M5 behavior:
    // a non-aborted conductor throw before any result reached the customer means the
    // customer is OWED a reply and got nothing. The web plane now opens a governed
    // incident (turn_error mapped to the frozen `send_failed` cause — the closest
    // "not delivered" cause; customer-impacted) AND delivers an honest deterministic
    // pt-BR fallback frame, never the bare {type:error} void.
    //
    // WHATSAPP PARITY (BKL-175 — CLOSED): the WhatsApp catch now mirrors this
    // backstop — a pre-send escape maps into the frozen `send_failed`, opens the
    // governed incident, and sends the apology-first fallback; only the POST-send
    // already-served `turn_error` stays incident-less (F2). Pinned in
    // whatsapp-webhook-async.test.ts.
    mockHandleTurn.mockRejectedValue(new Error("conductor exploded"));

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message: "oi", channel: "web" },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);
    await waitFor(() => mockOpenIncidentInline.mock.calls.length > 0);

    // A governed incident IS opened now (send_failed, customer-impacted) + NATS fan-out.
    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "send_failed", channel: "web", customerImpacted: true, sessionId: SID }),
      expect.anything(),
    );
    expect(mockEmitNoDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "send_failed", customerImpacted: true }),
      expect.anything(),
    );

    // The honest pt-BR fallback reached the client (text_delta + done), never {type:error}.
    const types = mockPushChunk.mock.calls.map(([, c]) => (c as { type: string }).type);
    expect(types).toContain("text_delta");
    expect(types).toContain("done");
    expect(types).not.toContain("error");
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

// ── BKL-212: confirm-resume niceties on the customer WEB ingress ────────────
// The web mirror of the OPS ingress patterns. Both branches act BEFORE
// handleTurn, so the mocked handleTurn is exactly the right seam: the decisive
// assertion on the two new paths is that the model turn NEVER runs, and on every
// other input that it runs exactly as it does today.
describe("POST /api/chat/messages — BKL-212 parked-confirmation niceties", () => {
  const PARK_PROMPT = "cancelar o pedido 4242";
  const INTENT_HASH = "abc123def456";
  const mockUnpark = vi.fn();

  /** Open the capsule with ONE parked confirmation (the customer-plane shape: no
   *  `expiresAt` — web parks carry no confirm-freshness TTL). */
  function withPark(): void {
    mockOpenCapsule.mockResolvedValue({
      id: "capsule-1",
      turnId: "turn-1",
      loadedSession: {
        id: "web:guest:session",
        pendingConfirmations: [
          {
            envelope: { kind: "order.cancel", intentHash: INTENT_HASH },
            confirmationToken: "tok-1",
            userPrompt: PARK_PROMPT,
            parkedAt: new Date().toISOString(),
          },
        ],
      },
      session: { unpark: mockUnpark },
    });
  }

  async function postGuest(message: string): Promise<void> {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message, channel: "web" },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);
    await app.close();
  }

  /** The text of the single delivered text_delta frame, or undefined. */
  function deliveredText(): string | undefined {
    return mockPushChunk.mock.calls
      .map(([, c]) => c as { type: string; delta?: { text?: string } })
      .find((c) => c.type === "text_delta")?.delta?.text;
  }

  beforeEach(() => {
    mockUnpark.mockReset();
    mockUnpark.mockResolvedValue(undefined);
  });

  it("explicit negative (\"não\") → deterministic decline ACK, park unparked, model NEVER called", async () => {
    withPark();
    await postGuest("não");

    // The whole point: no model turn — the negative text never reaches the planner
    // (claustrum's own deny path would re-plan it as a fresh command, BKL-191).
    expect(mockHandleTurn).not.toHaveBeenCalled();
    // Unparked BEFORE the turn, keyed on the parked envelope's intentHash.
    expect(mockUnpark).toHaveBeenCalledWith("web:guest:session", INTENT_HASH);
    // pt-BR ACK delivered + persisted + terminal done.
    expect(deliveredText()).toBe(
      "Ok, não vou fazer isso — nada foi alterado. Se precisar de outra coisa, é só me dizer.",
    );
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
    expect(assistantWasPersisted()).toBe(true);
    // A deterministic ingress reply is not a drop.
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    expect(mockCloseCapsule).toHaveBeenCalledTimes(1);
  });

  it("bare soft affirmative (\"ok\") → restates the parked prompt, park KEPT, model NEVER called", async () => {
    withPark();
    await postGuest("ok");

    expect(mockHandleTurn).not.toHaveBeenCalled();
    // Money-safety: a soft affirmative must never execute AND must never unpark —
    // the park survives so a follow-up "sim" still runs the adjudicated resume.
    expect(mockUnpark).not.toHaveBeenCalled();
    expect(deliveredText()).toBe(
      `Só confirmando — você quer que eu faça "${PARK_PROMPT}"? Responda "sim" para eu seguir.`,
    );
    expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
    expect(assistantWasPersisted()).toBe(true);
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
  });

  it.each(["pode", "beleza", "OK!"])(
    "soft affirmative variant %j also restates without unparking",
    async (text) => {
      withPark();
      await postGuest(text);
      expect(mockHandleTurn).not.toHaveBeenCalled();
      expect(mockUnpark).not.toHaveBeenCalled();
      expect(deliveredText()).toContain("Só confirmando");
    },
  );

  it("mixed soft affirmative + content (\"ok mas muda para 19h\") → NORMAL turn, park untouched", async () => {
    withPark();
    await postGuest("ok mas muda para 19h");

    // The customer issued a NEW request; restating would drop it. Normal loop.
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(mockUnpark).not.toHaveBeenCalled();
    expect(deliveredText()).toBe("Olá! Como posso ajudar?");
  });

  it("explicit confirm (\"sim\") → NORMAL turn (the adjudicated confirm-resume path is untouched)", async () => {
    withPark();
    await postGuest("sim");

    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(mockUnpark).not.toHaveBeenCalled(); // the conductor owns the resume unpark
    expect(deliveredText()).toBe("Olá! Como posso ajudar?");
  });

  it("mixed affirmative + negative (\"não, pode deixar\") → NORMAL turn, park KEPT (ambiguity is money-safe)", async () => {
    withPark();
    await postGuest("não, pode deixar");

    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(mockUnpark).not.toHaveBeenCalled();
  });

  it.each(["não", "ok", "sim", "quero uma costela"])(
    "NO park present: %j takes the normal path byte-identically",
    async (text) => {
      // Default capsule — no loadedSession at all (today's shape).
      await postGuest(text);

      expect(mockHandleTurn).toHaveBeenCalledTimes(1);
      expect(mockUnpark).not.toHaveBeenCalled();
      expect(mockPushChunk).toHaveBeenCalledWith(SID, {
        type: "text_delta",
        delta: mintRenderedReply("Olá! Como posso ajudar?"),
      });
      expect(mockPushChunk).toHaveBeenCalledWith(SID, { type: "done" });
      expect(assistantWasPersisted()).toBe(true);
    },
  );

  it("fail-honest: an unpark failure falls through to the normal loop instead of claiming a cancellation", async () => {
    withPark();
    mockUnpark.mockRejectedValue(new Error("redis down"));
    await postGuest("não");

    // The park did NOT clear, so we must not acknowledge a cancellation — run the
    // normal loop (claustrum's own deny path still unparks there).
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(deliveredText()).toBe("Olá! Como posso ajudar?");
  });

  it("the decline ACK is branded on the wire exactly like a conductor reply", async () => {
    withPark();
    await postGuest("cancela");

    expect(mockHandleTurn).not.toHaveBeenCalled();
    expect(mockPushChunk).toHaveBeenCalledWith(SID, {
      type: "text_delta",
      delta: mintRenderedReply(
        "Ok, não vou fazer isso — nada foi alterado. Se precisar de outra coisa, é só me dizer.",
      ),
    });
  });

  // ── F-3 · A SAFETY MARKER OUTRANKS THE DECLINE SHORT-CIRCUIT ──────────────
  // The WEB customer surface has shipped the decline branch since BKL-212, so it
  // carried the same defect as the WhatsApp surface: `isPureNegativeReplyText("não,
  // sou celíaco")` is TRUE, and the ACK above answered a declared medical marker
  // while §O#9 / BKL-184 never saw it. The owner's standing F-3 ruling (PR #515)
  // is applied at the triage seam, so the turn now RUNS and the existing machinery
  // routes. `mockHandleTurn` is the witness — the triage skips the turn, so "the
  // model was never called" is what separates an intercepted reply from one that
  // fell through.
  it("F-3: a marker-bearing negative reaches handleTurn — the triage stands down and unparks NOTHING", async () => {
    withPark();
    await postGuest("não, sou celíaco");

    // The turn RAN: the marker is now in front of the planner.
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    // The TRIAGE claimed no cancellation — it unparked nothing. (In production the
    // conductor's own deny path owns the park from here; `handleTurn` is mocked.)
    expect(mockUnpark).not.toHaveBeenCalled();
    // No decline ACK on the wire; the turn's own reply is delivered.
    expect(deliveredText()).toBe("Olá! Como posso ajudar?");
  });

  it("F-3 CONTROL: a marker-FREE negative of the same shape still declines byte-identically", async () => {
    withPark();
    // `vegetariano` is deliberately OUT of the diet net (BKL-214 preference vs
    // restriction), so only the MARKER differs from the case above. Without this
    // control, "handleTurn was called" would also pass against a deleted branch.
    await postGuest("não, sou vegetariano");

    expect(mockHandleTurn).not.toHaveBeenCalled();
    expect(mockUnpark).toHaveBeenCalledWith("web:guest:session", INTENT_HASH);
    expect(deliveredText()).toBe(
      "Ok, não vou fazer isso — nada foi alterado. Se precisar de outra coisa, é só me dizer.",
    );
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

// ── R4-S2 · the DECLARED per-turn context subset, observed at this ingress ──
//
// Before R4-S2 this ingress hand-assembled the funnel publish + the wire context +
// the workflow binding, and NO suite at any of the five ingresses observed any of
// them: the whole choreography could be deleted and every existing test stayed
// green. These probes close that blind spot from the CONSUMER side — the real route
// runs, and `handleTurn` (mocked here) reads the contexts' own APIs from inside the
// turn, which is the only place they are meant to be visible.
describe("POST /api/chat/messages — R4-S2 per-turn context subset (customer-full)", () => {
  const TURN_ID = "turn-1";

  interface Observed {
    readonly funnel: { readonly confirmWindowOpen: boolean } | undefined;
    readonly workflowTurnId: string | undefined;
    readonly workflowChannel: string | undefined;
    readonly wireExchanges: number;
  }

  /** Probe every context from INSIDE the turn, then answer like a normal turn. */
  function probeInsideTurn(): { read: () => Observed | undefined } {
    let observed: Observed | undefined;
    mockHandleTurn.mockImplementation(async () => {
      captureWireExchange({
        model: "nemotron",
        request: { messages: [] },
        response: { choices: [] },
        at: new Date().toISOString(),
      });
      sealWireCall(TURN_ID);
      observed = {
        funnel: funnelTurnContext(TURN_ID),
        workflowTurnId: currentWorkflowTurnId(),
        workflowChannel: currentWorkflowChannel(),
        wireExchanges: claimWireExchanges(TURN_ID).length,
      };
      return { response: { text: "Olá! Como posso ajudar?" }, decision: { kind: "EXECUTE" } };
    });
    return { read: () => observed };
  }

  /** Open the capsule with `parks` pending confirmations (customer shape: no TTL). */
  function withParks(parks: number): void {
    mockOpenCapsule.mockResolvedValue({
      id: "capsule-1",
      turnId: TURN_ID,
      loadedSession: {
        id: "web:guest:session",
        pendingConfirmations: Array.from({ length: parks }, (_unused, i) => ({
          envelope: { kind: "order.cancel", intentHash: `hash${i}` },
          confirmationToken: `tok-${i}`,
          userPrompt: "cancelar o pedido 4242",
          parkedAt: new Date().toISOString(),
        })),
      },
      session: { unpark: vi.fn(async () => {}) },
    });
  }

  async function postGuest(message: string): Promise<void> {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: SID, message, channel: "web" },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => mockReleaseLock.mock.calls.length > 0);
    await app.close();
  }

  it("establishes ALL THREE contexts around the turn — wire, workflow binding, funnel", async () => {
    const probe = probeInsideTurn();
    await postGuest("oi");

    expect(probe.read()).toEqual({
      funnel: { confirmWindowOpen: false },
      workflowTurnId: TURN_ID,
      workflowChannel: "web",
      wireExchanges: 1,
    });
  });

  it("publishes confirmWindowOpen TRUE when the session holds a park (FE-D32)", async () => {
    // A plain request — neither a soft affirmative nor a negative — so the
    // park-reply triage falls THROUGH to the turn and the funnel gets published.
    withParks(1);
    const probe = probeInsideTurn();
    await postGuest("quero uma picanha");

    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(probe.read()?.funnel).toEqual({ confirmWindowOpen: true });
  });

  it("publishes confirmWindowOpen FALSE on an EMPTY park list", async () => {
    withParks(0);
    const probe = probeInsideTurn();
    await postGuest("quero uma picanha");

    expect(probe.read()?.funnel).toEqual({ confirmWindowOpen: false });
  });

  it("drops the funnel context after the turn — and STILL drops it when the turn THROWS", async () => {
    withParks(1);
    mockHandleTurn.mockImplementation(async () => {
      // Live inside the turn…
      expect(funnelTurnContext(TURN_ID)).toEqual({ confirmWindowOpen: true });
      throw new Error("planner exploded");
    });
    await postGuest("quero uma picanha");

    // …and gone after it, via turn-context.ts's single `finally`. A leak here is a
    // cross-turn hazard: the next turn on a park-free session would inherit an
    // open confirm window and L0 would stand down for no reason.
    expect(funnelTurnContext(TURN_ID)).toBeUndefined();
    expect(currentWorkflowTurnId()).toBeUndefined();
  });
});
