// AUDIT-FIX: Phase 3 — Direct unit tests for requireAuth / optionalAuth middleware
//
// Validates:
//   1. requireAuth returns 401 AND handler side-effects do NOT execute
//   2. optionalAuth allows unauthenticated requests but doesn't set customerId

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

// Mock @fastify/jwt — we dynamically import auth.ts so it needs jwtVerify decoration
const mockJwtVerify = vi.hoisted(() => vi.fn());

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
  app.decorateRequest("user", null);
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
