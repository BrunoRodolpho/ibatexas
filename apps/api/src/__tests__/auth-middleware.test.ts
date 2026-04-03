// Unit tests for requireAuth / optionalAuth middleware
//
// Validates:
//   1. requireAuth returns 401 AND handler side-effects do NOT execute
//   2. optionalAuth allows unauthenticated requests but doesn't set customerId

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

// Mock @fastify/jwt — we dynamically import auth.ts so it needs jwtVerify decoration
const mockJwtVerify = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

// ── Server factory ─────────────────────────────────────────────────────────────

/**
 * Build a minimal Fastify server that registers the real requireAuth / optionalAuth
 * middleware from apps/api/src/middleware/auth.ts.
 *
 * The route handlers use a side-effect tracker so tests can assert whether they
 * executed or not.
 */
async function buildTestServer() {
  const app = Fastify({ logger: false });

  // Decorate request with jwtVerify and user — simulates @fastify/jwt
  app.decorateRequest("jwtVerify", async function (this: unknown) {
    return mockJwtVerify.call(this);
  });
  app.decorateRequest("user", null as never);
  // Add Fastify request fields expected by auth middleware
  app.decorateRequest("customerId", undefined);
  app.decorateRequest("userType", undefined);

  // Import the real middleware
  const { requireAuth, optionalAuth } = await import("../middleware/auth.js");

  const sideEffects: string[] = [];

  app.get(
    "/protected",
    { preHandler: requireAuth },
    async (request, reply) => {
      sideEffects.push("protected-handler-executed");
      return reply.send({ customerId: request.customerId });
    },
  );

  app.get(
    "/optional",
    { preHandler: optionalAuth },
    async (request, reply) => {
      sideEffects.push("optional-handler-executed");
      return reply.send({ customerId: request.customerId ?? null });
    },
  );

  await app.ready();
  return { app, sideEffects };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("requireAuth middleware", () => {
  let server: FastifyInstance;
  let sideEffects: string[];

  beforeAll(async () => {
    const built = await buildTestServer();
    server = built.app;
    sideEffects = built.sideEffects;
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns 401 AND handler side-effects do NOT execute when JWT is missing", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBe("Unauthorized");
    // The critical assertion: the route handler must NOT have executed
    expect(sideEffects).not.toContain("protected-handler-executed");
    expect(sideEffects).toHaveLength(0);
  });

  it("returns 401 when JWT is invalid (jwtVerify resolves but no sub)", async () => {
    sideEffects.length = 0;
    // jwtVerify succeeds but doesn't set user payload (no sub)
    mockJwtVerify.mockResolvedValue(undefined);

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(401);
    expect(sideEffects).toHaveLength(0);
  });

  it("allows request and sets customerId when JWT is valid", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      // Simulate @fastify/jwt setting the user payload
      this.user = { sub: "cust_123", userType: "customer" };
    });

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customerId).toBe("cust_123");
    expect(sideEffects).toContain("protected-handler-executed");
  });
});

describe("optionalAuth middleware", () => {
  let server: FastifyInstance;
  let sideEffects: string[];

  beforeAll(async () => {
    const built = await buildTestServer();
    server = built.app;
    sideEffects = built.sideEffects;
  });

  afterAll(async () => {
    await server.close();
  });

  it("allows unauthenticated requests and does not set customerId", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const response = await server.inject({
      method: "GET",
      url: "/optional",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customerId).toBeNull();
    expect(sideEffects).toContain("optional-handler-executed");
  });

  it("sets customerId when JWT is valid", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "cust_456", userType: "customer" };
    });

    const response = await server.inject({
      method: "GET",
      url: "/optional",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customerId).toBe("cust_456");
    expect(sideEffects).toContain("optional-handler-executed");
  });
});

// ── SEC-004: JWT revocation check in extractAuth ────────────────────────────

describe("JWT revocation (SEC-004)", () => {
  let server: FastifyInstance;
  let sideEffects: string[];

  beforeAll(async () => {
    const built = await buildTestServer();
    server = built.app;
    sideEffects = built.sideEffects;
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `test:${key}`);
  });

  it("rejects a revoked token (returns 401 on protected route)", async () => {
    sideEffects.length = 0;
    // JWT verification succeeds but the token has a jti that is revoked
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "cust_revoked", userType: "customer", jti: "revoked-jti" };
    });
    const mockRedis = { get: vi.fn().mockResolvedValue("1") };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(401);
    expect(sideEffects).not.toContain("protected-handler-executed");
    // Verify the revocation key was checked
    expect(mockRedis.get).toHaveBeenCalledWith(
      expect.stringContaining("jwt:revoked:revoked-jti"),
    );
  });

  it("allows a non-revoked token (returns 200)", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "cust_ok", userType: "customer", jti: "valid-jti" };
    });
    const mockRedis = { get: vi.fn().mockResolvedValue(null) };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customerId).toBe("cust_ok");
  });

  it("fails closed when Redis is down (SEC-004: reject rather than accept potentially revoked tokens)", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "cust_fallback", userType: "customer", jti: "some-jti" };
    });
    mockGetRedisClient.mockRejectedValue(new Error("Connection refused"));

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    // Fail closed: Redis unavailable → 503, not 200
    expect(response.statusCode).toBe(503);
  });

  it("skips revocation check for legacy tokens without jti", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      // Legacy token — no jti field
      this.user = { sub: "cust_legacy", userType: "customer" };
    });

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(200);
    // Redis should not have been called (no jti to check)
    expect(mockGetRedisClient).not.toHaveBeenCalled();
  });
});
