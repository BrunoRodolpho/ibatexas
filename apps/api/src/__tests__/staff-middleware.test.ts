// Unit tests for DOM-001: staff-auth middleware (requireStaff, requireManager)
//
// Validates:
//   1. requireStaff allows staff tokens and blocks customer/no tokens
//   2. requireManager allows OWNER/MANAGER but blocks ATTENDANT
//   3. extractAuth correctly populates staffId/staffRole from staff JWTs

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockJwtVerify = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

// ── Staff-token helper ─────────────────────────────────────────────────────────
//
// audit-2026-05-25 (commit d0b41d7) made extractAuth reject staff JWTs on the
// CUSTOMER cookie path: when `request.jwtVerify()` yields a `userType: "staff"`
// payload, extractAuth returns early WITHOUT setting staffId/staffRole. Staff
// principals are now minted ONLY from the separate `staff_token` cookie, which
// extractAuth verifies via `request.server.jwt.verify(rawToken)` (see
// auth.ts ── "Staff path"). The harness must therefore drive that path: send a
// `staff_token` cookie and provide a `server.jwt.verify` that decodes it.
//
// We encode the test payload as JSON (the harness owns both sign + verify);
// the payload shape mirrors signStaffToken() in routes/auth.ts.
type StaffTokenPayload = {
  sub: string;
  userType: "staff";
  role: "OWNER" | "MANAGER" | "ATTENDANT";
  jti?: string;
  aud?: string;
};

function staffCookie(payload: StaffTokenPayload): string {
  return JSON.stringify(payload);
}

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });

  // @fastify/cookie populates request.cookies — extractAuth reads
  // request.cookies?.["staff_token"] on the staff path.
  await app.register(fastifyCookie);

  // Decorate request with jwtVerify and user — simulates @fastify/jwt's
  // customer-cookie path (`request.jwtVerify()` reads the `token` cookie).
  app.decorateRequest("jwtVerify", async function (this: unknown) {
    return mockJwtVerify.call(this);
  });
  app.decorateRequest("user", null as never);
  app.decorateRequest("customerId", undefined);
  app.decorateRequest("userType", undefined);
  app.decorateRequest("staffId", undefined);
  app.decorateRequest("staffRole", undefined);

  // Simulate @fastify/jwt's synchronous `server.jwt.verify(token)` used by the
  // staff_token path. extractAuth reads it via `request.server.jwt.verify`.
  app.decorate("jwt", {
    verify(token: string): StaffTokenPayload {
      return JSON.parse(token) as StaffTokenPayload;
    },
  } as never);

  // Import real middleware
  const { requireAuth, optionalAuth } = await import("../middleware/auth.js");
  const { requireStaff, requireManager } = await import("../middleware/staff-auth.js");

  const sideEffects: string[] = [];

  // Route requiring staff auth
  app.get(
    "/staff-only",
    { preHandler: [optionalAuth, requireStaff] },
    async (request, reply) => {
      sideEffects.push("staff-handler");
      return reply.send({ staffId: request.staffId, staffRole: request.staffRole });
    },
  );

  // Route requiring manager-level auth
  app.get(
    "/manager-only",
    { preHandler: [optionalAuth, requireManager] },
    async (request, reply) => {
      sideEffects.push("manager-handler");
      return reply.send({ staffId: request.staffId, staffRole: request.staffRole });
    },
  );

  // Route requiring customer auth (for contrast)
  app.get(
    "/customer-only",
    { preHandler: requireAuth },
    async (request, reply) => {
      sideEffects.push("customer-handler");
      return reply.send({ customerId: request.customerId });
    },
  );

  await app.ready();
  return { app, sideEffects };
}

// ── requireStaff tests ──────────────────────────────────────────────────────

describe("requireStaff middleware", () => {
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
    // Staff tokens carry a jti, so extractAuth runs the revocation check
    // (getRedisClient().get(...)). Return a redis whose get() yields null so
    // the token reads as NOT revoked. checkRevocation fails CLOSED on redis
    // errors, so an unwired mock would surface as 503, not the auth result.
    mockGetRedisClient.mockResolvedValue({ get: vi.fn(async () => null) });
    sideEffects.length = 0;
  });

  it("allows request with valid staff JWT (MANAGER)", async () => {
    // No customer `token` cookie → customer path rejects → extractAuth falls
    // through to the `staff_token` cookie path.
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({
      method: "GET",
      url: "/staff-only",
      cookies: {
        staff_token: staffCookie({
          sub: "staff_01",
          userType: "staff",
          role: "MANAGER",
          jti: "jti_01",
          aud: "staff_token",
        }),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.staffId).toBe("staff_01");
    expect(body.staffRole).toBe("MANAGER");
    expect(sideEffects).toContain("staff-handler");
  });

  it("allows request with valid staff JWT (OWNER)", async () => {
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({
      method: "GET",
      url: "/staff-only",
      cookies: {
        staff_token: staffCookie({
          sub: "staff_02",
          userType: "staff",
          role: "OWNER",
          jti: "jti_02",
          aud: "staff_token",
        }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().staffRole).toBe("OWNER");
  });

  it("allows request with valid staff JWT (ATTENDANT)", async () => {
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({
      method: "GET",
      url: "/staff-only",
      cookies: {
        staff_token: staffCookie({
          sub: "staff_03",
          userType: "staff",
          role: "ATTENDANT",
          jti: "jti_03",
          aud: "staff_token",
        }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().staffRole).toBe("ATTENDANT");
  });

  it("returns 403 when JWT is a customer token (not staff)", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "cust_01", userType: "customer" };
    });

    const res = await server.inject({ method: "GET", url: "/staff-only" });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.message).toContain("funcionários");
    expect(sideEffects).not.toContain("staff-handler");
  });

  it("returns 403 when no JWT is present", async () => {
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({ method: "GET", url: "/staff-only" });

    expect(res.statusCode).toBe(403);
    expect(sideEffects).not.toContain("staff-handler");
  });
});

// ── requireManager tests ────────────────────────────────────────────────────

describe("requireManager middleware", () => {
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
    // Staff tokens carry a jti, so extractAuth runs the revocation check
    // (getRedisClient().get(...)). Return a redis whose get() yields null so
    // the token reads as NOT revoked. checkRevocation fails CLOSED on redis
    // errors, so an unwired mock would surface as 503, not the auth result.
    mockGetRedisClient.mockResolvedValue({ get: vi.fn(async () => null) });
    sideEffects.length = 0;
  });

  it("allows OWNER role", async () => {
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({
      method: "GET",
      url: "/manager-only",
      cookies: {
        staff_token: staffCookie({
          sub: "staff_owner",
          userType: "staff",
          role: "OWNER",
          jti: "jti_owner",
          aud: "staff_token",
        }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().staffRole).toBe("OWNER");
    expect(sideEffects).toContain("manager-handler");
  });

  it("allows MANAGER role", async () => {
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({
      method: "GET",
      url: "/manager-only",
      cookies: {
        staff_token: staffCookie({
          sub: "staff_mgr",
          userType: "staff",
          role: "MANAGER",
          jti: "jti_mgr",
          aud: "staff_token",
        }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().staffRole).toBe("MANAGER");
    expect(sideEffects).toContain("manager-handler");
  });

  it("returns 403 for ATTENDANT role", async () => {
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({
      method: "GET",
      url: "/manager-only",
      cookies: {
        staff_token: staffCookie({
          sub: "staff_att",
          userType: "staff",
          role: "ATTENDANT",
          jti: "jti_att",
          aud: "staff_token",
        }),
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.message).toContain("gerentes");
    expect(sideEffects).not.toContain("manager-handler");
  });

  it("returns 403 for customer tokens", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "cust_01", userType: "customer" };
    });

    const res = await server.inject({ method: "GET", url: "/manager-only" });

    expect(res.statusCode).toBe(403);
    expect(sideEffects).not.toContain("manager-handler");
  });

  it("returns 403 when unauthenticated", async () => {
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({ method: "GET", url: "/manager-only" });

    expect(res.statusCode).toBe(403);
    expect(sideEffects).not.toContain("manager-handler");
  });
});

// ── extractAuth staff token handling ──────────────────────────────────────

describe("extractAuth handles staff tokens correctly", () => {
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
    // Staff tokens carry a jti, so extractAuth runs the revocation check
    // (getRedisClient().get(...)). Return a redis whose get() yields null so
    // the token reads as NOT revoked. checkRevocation fails CLOSED on redis
    // errors, so an unwired mock would surface as 503, not the auth result.
    mockGetRedisClient.mockResolvedValue({ get: vi.fn(async () => null) });
    sideEffects.length = 0;
  });

  it("sets staffId and staffRole for staff JWT, not customerId", async () => {
    mockJwtVerify.mockRejectedValue(new Error("no token"));

    const res = await server.inject({
      method: "GET",
      url: "/staff-only",
      cookies: {
        staff_token: staffCookie({
          sub: "staff_01",
          userType: "staff",
          role: "MANAGER",
          jti: "jti_x1",
          aud: "staff_token",
        }),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.staffId).toBe("staff_01");
    expect(body.staffRole).toBe("MANAGER");
  });

  it("sets customerId for customer JWT, not staffId", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "cust_01", userType: "customer" };
    });

    const res = await server.inject({ method: "GET", url: "/customer-only" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.customerId).toBe("cust_01");
  });
});
