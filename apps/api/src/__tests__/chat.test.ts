// Unit tests for POST /api/chat/messages and GET /api/chat/stream/:sessionId
// Mocks loadSession, appendMessages, the streaming emitter, and Redis.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { Channel } from "@ibatexas/types";
import { chatRoutes } from "../routes/chat.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockLoadSession = vi.hoisted(() => vi.fn());
const mockAppendMessages = vi.hoisted(() => vi.fn());
const mockIsStreamActive = vi.hoisted(() => vi.fn());
const mockCreateStream = vi.hoisted(() => vi.fn());
const mockPushChunk = vi.hoisted(() => vi.fn());
const mockGetStream = vi.hoisted(() => vi.fn());
const mockSubscribeToStream = vi.hoisted(() => vi.fn());
const mockCleanupStream = vi.hoisted(() => vi.fn());
const mockAcquireWebAgentLock = vi.hoisted(() => vi.fn());
const mockReleaseWebAgentLock = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());

vi.mock("../session/store.js", () => ({
  loadSession: mockLoadSession,
  appendMessages: mockAppendMessages,
}));
vi.mock("../streaming/emitter.js", () => ({
  isStreamActive: mockIsStreamActive,
  createStream: mockCreateStream,
  pushChunk: mockPushChunk,
  getStream: mockGetStream,
  subscribeToStream: mockSubscribeToStream,
  cleanupStream: mockCleanupStream,
}));
vi.mock("../streaming/execution-queue.js", () => ({
  acquireWebAgentLock: mockAcquireWebAgentLock,
  releaseWebAgentLock: mockReleaseWebAgentLock,
}));
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getRedisClient: mockGetRedisClient,
  };
});

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(chatRoutes);
  await app.ready();
  return app;
}

const VALID_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("POST /api/chat/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsStreamActive.mockReturnValue(false);
    mockLoadSession.mockResolvedValue([]);
    mockAppendMessages.mockResolvedValue(undefined);
    mockCreateStream.mockReturnValue(undefined);
    mockCleanupStream.mockReturnValue(undefined);
    mockPushChunk.mockReturnValue(undefined);
    mockAcquireWebAgentLock.mockResolvedValue(true);
    mockReleaseWebAgentLock.mockResolvedValue(undefined);
    mockGetRedisClient.mockResolvedValue({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
    });
  });

  it("returns { messageId } and opens a stream", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: VALID_SESSION_ID,
        message: "oi",
        channel: Channel.Web,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { messageId: string };
    expect(body.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(mockCreateStream).toHaveBeenCalledWith(VALID_SESSION_ID);
  });

  it("returns 409 when a stream is already active for the session", async () => {
    mockAcquireWebAgentLock.mockResolvedValue(false);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: VALID_SESSION_ID,
        message: "oi",
        channel: Channel.Web,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(mockCreateStream).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body (missing message)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: { sessionId: VALID_SESSION_ID, channel: Channel.Web },
    });

    expect(res.statusCode).toBe(400);
  });

  it("pushes an error chunk when the conductor turn fails", async () => {
    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      payload: {
        sessionId: VALID_SESSION_ID,
        message: "oi",
        channel: Channel.Web,
      },
    });

    // Wait for the fire-and-forget to settle
    await vi.waitFor(() => {
      expect(mockPushChunk).toHaveBeenCalledWith(
        VALID_SESSION_ID,
        expect.objectContaining({ type: "error" }),
      );
    }, { timeout: 500 });
  });

  // P2-I18N-CHATEN: guest secret mismatch must reject in pt-BR, not English.
  it("rejects a guest with a wrong session secret in pt-BR", async () => {
    mockGetRedisClient.mockResolvedValue({
      get: vi.fn().mockImplementation(async (key: string) =>
        key.includes("session:secret") ? "the-real-secret" : null,
      ),
      set: vi.fn().mockResolvedValue("OK"),
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { "x-session-secret": "wrong-secret" },
      payload: {
        sessionId: VALID_SESSION_ID,
        message: "oi",
        channel: Channel.Web,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { message: string };
    expect(body.message).toBe("Segredo de sessão inválido.");
    // Guard against an English regression.
    expect(body.message).not.toMatch(/invalid session secret/i);
  });
});

describe("GET /api/chat/stream/:sessionId", () => {
  // Stored guest secret the SSE endpoint now validates against (P2-SEC-SSECORS).
  const GUEST_SECRET = "guest-secret-abc";

  beforeEach(() => {
    vi.clearAllMocks();
    // Guest streams (no x-session-token) must present a matching x-session-secret.
    // Mock redis so the stored secret is GUEST_SECRET (owner key unused for guests).
    mockGetRedisClient.mockResolvedValue({
      get: vi.fn().mockImplementation(async (key: string) =>
        key.includes("session:secret") ? GUEST_SECRET : null,
      ),
      set: vi.fn().mockResolvedValue("OK"),
    });
  });

  it("replays buffered chunks and ends the stream", async () => {
    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();
    mockGetStream.mockReturnValue({
      emitter,
      buffer: [
        { type: "text_delta", delta: "Olá" },
        { type: "done" },
      ],
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
      headers: { "x-session-secret": GUEST_SECRET },
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain(`"type":"text_delta"`);
    expect(res.body).toContain(`"type":"done"`);
  });

  it("returns error event when session not found after polling", async () => {
    mockGetStream.mockReturnValue(undefined);
    mockSubscribeToStream.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
      headers: { "x-session-secret": GUEST_SECRET },
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain(`"type":"error"`);
  });

  // ── P2-MEM-SSEHEARTBEAT ─────────────────────────────────────────────────────

  it("writes a keep-alive heartbeat comment while the stream stays open", async () => {
    // Tiny interval so a couple of pings fire before we close the stream.
    vi.stubEnv("SSE_HEARTBEAT_MS", "5");

    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();
    // Non-terminal buffer: the response stays open and the heartbeat ticks
    // until we emit a terminal `done` below.
    mockGetStream.mockReturnValue({ emitter, buffer: [{ type: "text_delta", delta: "oi" }] });

    const app = await buildTestServer();
    // Emit the terminal chunk after a few heartbeat intervals have elapsed so
    // inject() resolves with the pings already written.
    setTimeout(() => emitter.emit("chunk", { type: "done" }), 40);

    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
      headers: { "x-session-secret": GUEST_SECRET },
    });

    // The SSE comment line proves the periodic keep-alive ran.
    expect(res.body).toContain(": ping");
    expect(res.body).toContain(`"type":"done"`);
    vi.unstubAllEnvs();
  });

  it("does not start a heartbeat when SSE_HEARTBEAT_MS is 0 (disabled)", async () => {
    vi.stubEnv("SSE_HEARTBEAT_MS", "0");

    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();
    mockGetStream.mockReturnValue({ emitter, buffer: [{ type: "text_delta", delta: "oi" }] });

    const app = await buildTestServer();
    setTimeout(() => emitter.emit("chunk", { type: "done" }), 30);

    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
      headers: { "x-session-secret": GUEST_SECRET },
    });

    expect(res.body).not.toContain(": ping");
    expect(res.body).toContain(`"type":"done"`);
    vi.unstubAllEnvs();
  });

  // ── P2-SEC-SSECORS regressions ──────────────────────────────────────────────

  it("denies a guest stream when x-session-secret is missing", async () => {
    mockGetStream.mockReturnValue({
      emitter: new (await import("node:events")).EventEmitter(),
      buffer: [{ type: "text_delta", delta: "secret-data" }, { type: "done" }],
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
      // No x-session-secret header.
    });

    expect(res.body).toContain("Acesso negado.");
    expect(res.body).not.toContain("secret-data");
  });

  it("denies a guest stream when x-session-secret does not match", async () => {
    mockGetStream.mockReturnValue({
      emitter: new (await import("node:events")).EventEmitter(),
      buffer: [{ type: "text_delta", delta: "secret-data" }, { type: "done" }],
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
      headers: { "x-session-secret": "wrong-secret" },
    });

    expect(res.body).toContain("Acesso negado.");
    expect(res.body).not.toContain("secret-data");
  });

  it("does NOT reflect a disallowed Origin with Allow-Credentials", async () => {
    vi.stubEnv("CORS_ORIGIN", "https://app.ibatexas.com");
    mockGetStream.mockReturnValue({
      emitter: new (await import("node:events")).EventEmitter(),
      buffer: [{ type: "done" }],
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
      headers: { "x-session-secret": GUEST_SECRET, origin: "https://evil.example.com" },
    });

    // The arbitrary Origin must not be echoed back.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("reflects an allowed Origin from the configured allowlist", async () => {
    vi.stubEnv("CORS_ORIGIN", "https://app.ibatexas.com");
    mockGetStream.mockReturnValue({
      emitter: new (await import("node:events")).EventEmitter(),
      buffer: [{ type: "done" }],
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
      headers: { "x-session-secret": GUEST_SECRET, origin: "https://app.ibatexas.com" },
    });

    expect(res.headers["access-control-allow-origin"]).toBe("https://app.ibatexas.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    vi.unstubAllEnvs();
  });
});
