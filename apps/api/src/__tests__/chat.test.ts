// Unit tests for POST /api/chat/messages and GET /api/chat/stream/:sessionId
// Mocks runAgent, loadSession, appendMessages, and the streaming emitter.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { Channel } from "@ibatexas/types";
import { mintRenderedReply } from "@adjudicate/core";
import { chatRoutes } from "../routes/chat.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

// WS7: the route delegates to the claustrum Conductor (getConductor +
// handleTurn) instead of runOrchestrator. Mock both so the POST tests exercise
// the conductor path hermetically.
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
const mockGetConductor = vi.hoisted(() => vi.fn());
const mockHandleTurn = vi.hoisted(() => vi.fn());
const mockOpenCapsule = vi.hoisted(() => vi.fn());
const mockCloseCapsule = vi.hoisted(() => vi.fn());

vi.mock("../claustrum-bootstrap.js", () => ({ getConductor: mockGetConductor }));
vi.mock("@claustrum/core", () => ({ handleTurn: mockHandleTurn }));
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
  // EGRESS BRAND (E-1): the route serializes via chunkToWire, extracting the
  // branded text_delta payload to a plain string for the SSE wire.
  chunkToWire: (chunk: { type: string; delta?: { text: string } }) =>
    chunk.type === "text_delta"
      ? { type: "text_delta", delta: chunk.delta?.text }
      : chunk,
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
    // Conductor: openCapsule → handleTurn → closeCapsule. Default = a single
    // assembled text response (Streaming Option A).
    mockOpenCapsule.mockResolvedValue({ id: "capsule-1" });
    mockCloseCapsule.mockResolvedValue(undefined);
    mockGetConductor.mockReturnValue({
      openCapsule: mockOpenCapsule,
      closeCapsule: mockCloseCapsule,
    });
    mockHandleTurn.mockResolvedValue({ response: { text: "Olá!" } });
  });

  it("returns { messageId } and starts agent", async () => {
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

  it("pushes error chunk when agent throws", async () => {
    mockHandleTurn.mockRejectedValue(new Error("Agent crashed"));

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
});

describe("GET /api/chat/stream/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ownership check: no owner, no guest secret → falls through to the
    // getStream/replay path (preserving dev's GET contract).
    mockGetRedisClient.mockResolvedValue({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
    });
    // Cross-replica path returns no subscription → the poll exhausts and the
    // handler writes "Sessão não encontrada" (the not-found error event).
    mockSubscribeToStream.mockResolvedValue(undefined);
  });

  it("replays buffered chunks and ends the stream", async () => {
    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();
    mockGetStream.mockReturnValue({
      emitter,
      buffer: [
        // EGRESS BRAND (E-1): an in-memory text_delta carries a branded
        // RenderedReply; the SSE chokepoint unwraps it after proving provenance.
        { type: "text_delta", delta: mintRenderedReply("Olá") },
        { type: "done" },
      ],
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain(`"type":"text_delta"`);
    expect(res.body).toContain(`"type":"done"`);
  });

  it("returns error event when session not found after polling", async () => {
    mockGetStream.mockReturnValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/stream/${VALID_SESSION_ID}`,
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain(`"type":"error"`);
  });
});
