// Unit tests for DOM-001: staff-auth middleware (requireStaff, requireManager)
//
// Validates:
//   1. requireStaff allows staff tokens and blocks customer/no tokens
//   2. requireManager allows OWNER/MANAGER but blocks ATTENDANT
//   3. extractAuth correctly populates staffId/staffRole from staff JWTs

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockJwtVerify = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });

  // Decorate request with jwtVerify and user — simulates @fastify/jwt
  app.decorateRequest("jwtVerify", async function (this: unknown) {
    return mockJwtVerify.call(this);
  });
  app.decorateRequest("user", null as never);
  app.decorateRequest("customerId", undefined);
  app.decorateRequest("userType", undefined);
  app.decorateRequest("staffId", undefined);
  app.decorateRequest("staffRole", undefined);

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
    sideEffects.length = 0;
  });

  it("allows request with valid staff JWT (MANAGER)", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "staff_01", userType: "staff", role: "MANAGER" };
    });

    const res = await server.inject({ method: "GET", url: "/staff-only" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.staffId).toBe("staff_01");
    expect(body.staffRole).toBe("MANAGER");
    expect(sideEffects).toContain("staff-handler");
  });

  it("allows request with valid staff JWT (OWNER)", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "staff_02", userType: "staff", role: "OWNER" };
    });

    const res = await server.inject({ method: "GET", url: "/staff-only" });

    expect(res.statusCode).toBe(200);
    expect(res.json().staffRole).toBe("OWNER");
  });

  it("allows request with valid staff JWT (ATTENDANT)", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "staff_03", userType: "staff", role: "ATTENDANT" };
    });

    const res = await server.inject({ method: "GET", url: "/staff-only" });

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
    sideEffects.length = 0;
  });

  it("allows OWNER role", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "staff_owner", userType: "staff", role: "OWNER" };
    });

    const res = await server.inject({ method: "GET", url: "/manager-only" });

    expect(res.statusCode).toBe(200);
    expect(res.json().staffRole).toBe("OWNER");
    expect(sideEffects).toContain("manager-handler");
  });

  it("allows MANAGER role", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "staff_mgr", userType: "staff", role: "MANAGER" };
    });

    const res = await server.inject({ method: "GET", url: "/manager-only" });

    expect(res.statusCode).toBe(200);
    expect(res.json().staffRole).toBe("MANAGER");
    expect(sideEffects).toContain("manager-handler");
  });

  it("returns 403 for ATTENDANT role", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "staff_att", userType: "staff", role: "ATTENDANT" };
    });

    const res = await server.inject({ method: "GET", url: "/manager-only" });

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
    sideEffects.length = 0;
  });

  it("sets staffId and staffRole for staff JWT, not customerId", async () => {
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "staff_01", userType: "staff", role: "MANAGER" };
    });

    const res = await server.inject({ method: "GET", url: "/staff-only" });

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
