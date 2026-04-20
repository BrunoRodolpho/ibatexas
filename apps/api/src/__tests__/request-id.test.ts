// Unit tests for OBS-001: request-id plugin
//
// Validates:
//   1. genRequestId uses client-provided x-request-id header
//   2. genRequestId generates a UUID when no header is present
//   3. genRequestId rejects oversized or empty headers
//   4. Response includes x-request-id header echoing the request ID
//   5. Sentry scope is tagged with the request ID

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { genRequestId, registerRequestId } from "../plugins/request-id.js";

// ── Hoisted Sentry mock ─────────────────────────────────────────────────────

const mockSetTag = vi.hoisted(() => vi.fn());
const mockGetCurrentScope = vi.hoisted(() => vi.fn(() => ({ setTag: mockSetTag })));

vi.mock("@sentry/node", () => ({
  getCurrentScope: mockGetCurrentScope,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({
    logger: false,
    genReqId: genRequestId,
  });

  registerRequestId(app);

  app.get("/test", async (request, reply) => {
    return reply.send({ requestId: request.id });
  });

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("genRequestId", () => {
  it("returns client-provided x-request-id when present", () => {
    const mockRequest = {
      headers: { "x-request-id": "client-trace-abc-123" },
    } as unknown as Parameters<typeof genRequestId>[0];

    const id = genRequestId(mockRequest);
    expect(id).toBe("client-trace-abc-123");
  });

  it("generates a UUID when x-request-id header is missing", () => {
    const mockRequest = {
      headers: {},
    } as unknown as Parameters<typeof genRequestId>[0];

    const id = genRequestId(mockRequest);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates a UUID when x-request-id is empty string", () => {
    const mockRequest = {
      headers: { "x-request-id": "" },
    } as unknown as Parameters<typeof genRequestId>[0];

    const id = genRequestId(mockRequest);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates a UUID when x-request-id exceeds 128 characters", () => {
    const longId = "x".repeat(129);
    const mockRequest = {
      headers: { "x-request-id": longId },
    } as unknown as Parameters<typeof genRequestId>[0];

    const id = genRequestId(mockRequest);
    expect(id).not.toBe(longId);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("accepts x-request-id at exactly 128 characters", () => {
    const maxId = "a".repeat(128);
    const mockRequest = {
      headers: { "x-request-id": maxId },
    } as unknown as Parameters<typeof genRequestId>[0];

    const id = genRequestId(mockRequest);
    expect(id).toBe(maxId);
  });

  it("generates unique IDs across multiple calls", () => {
    const mockRequest = {
      headers: {},
    } as unknown as Parameters<typeof genRequestId>[0];

    const ids = new Set(Array.from({ length: 10 }, () => genRequestId(mockRequest)));
    expect(ids.size).toBe(10);
  });
});

describe("requestIdPlugin integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("echoes x-request-id in response when client provides one", async () => {
    const app = await buildTestServer();
    const clientId = "my-trace-id-456";

    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-request-id": clientId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe(clientId);

    const body = res.json();
    expect(body.requestId).toBe(clientId);
  });

  it("generates and returns x-request-id when client does not provide one", async () => {
    const app = await buildTestServer();

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });

    expect(res.statusCode).toBe(200);
    const responseId = res.headers["x-request-id"];
    expect(responseId).toBeDefined();
    expect(responseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const body = res.json();
    expect(body.requestId).toBe(responseId);
  });

  it("tags Sentry scope with the request ID", async () => {
    const app = await buildTestServer();
    const clientId = "sentry-trace-789";

    await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-request-id": clientId },
    });

    expect(mockGetCurrentScope).toHaveBeenCalled();
    expect(mockSetTag).toHaveBeenCalledWith("requestId", clientId);
  });

  it("tags Sentry with generated ID when no client header", async () => {
    const app = await buildTestServer();

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });

    const generatedId = res.headers["x-request-id"] as string;
    expect(mockSetTag).toHaveBeenCalledWith("requestId", generatedId);
  });

  it("request.id matches the response header", async () => {
    const app = await buildTestServer();

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });

    const body = res.json();
    expect(body.requestId).toBe(res.headers["x-request-id"]);
  });
});
