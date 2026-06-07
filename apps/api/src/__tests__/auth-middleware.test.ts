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

// STAFFREVOKE: the staff path re-checks createStaffService().getById(sub).active
// on every request. Mock it so the staff active-check tests can drive it.
const mockGetStaffById = vi.hoisted(() => vi.fn());
const mockStaffJwtVerify = vi.hoisted(() => vi.fn());
// JWTSPLIT: the customer (default) jwt instance — staff tokens must NOT verify here.
const mockCustomerInstanceVerify = vi.hoisted(() => vi.fn());
vi.mock("@ibatexas/domain", () => ({
  createStaffService: () => ({ getById: mockGetStaffById }),
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

  // Staff path support (STAFFREVOKE): the middleware reads request.cookies?.["staff_token"]
  // and verifies it via request.server.jwt.verify. Register a cookie parser + decorate
  // a jwt verifier so the staff active-check can be exercised end-to-end.
  await app.register((await import("@fastify/cookie")).default);
  // JWTSPLIT: staff verification routes through the dedicated server.jwt.staff
  // instance; the default (customer) instance must never verify a staff token.
  app.decorate("jwt", {
    verify: (token: string) => mockCustomerInstanceVerify(token),
    staff: { verify: (token: string) => mockStaffJwtVerify(token) },
  } as never);
  app.get(
    "/staff-check",
    { preHandler: optionalAuth },
    async (request, reply) =>
      reply.send({ staffId: request.staffId ?? null, userType: request.userType ?? null }),
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

// ── audit-2026-05-24 P1-6: whitespace-only `sub` is rejected ──────────────
//
// W7-G1 patched the OTP gate via `normalizeSub`, but the middleware itself
// still only rejected the empty string. A JWT with `sub: "   "` would have
// populated `request.customerId` with whitespace and then collided on
// shared Redis keys (defer:pending:, otp:fail:…) the same way the empty
// string does. The three middleware sites (customer path, staff path,
// requireAuth gate) now all `.trim().length === 0` check.
describe("requireAuth rejects whitespace-only `sub` (audit-2026-05-24 P1-6)", () => {
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

  it("returns 401 when JWT `sub` is whitespace-only (customer path)", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      // Whitespace-only sub — must not populate customerId
      this.user = { sub: "   ", userType: "customer" };
    });

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(401);
    // The route handler must NOT have executed
    expect(sideEffects).not.toContain("protected-handler-executed");
  });

  it("returns 401 when JWT `sub` is tab/newline (customer path)", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: "\t\n ", userType: "customer" };
    });

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(401);
    expect(sideEffects).not.toContain("protected-handler-executed");
  });

  it("does NOT pass through to handler when whitespace `sub` (defense-in-depth)", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = { sub: " ", userType: "customer" };
    });

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    // The middleware must NOT populate request.customerId with " ".
    // The status should be 401, NOT 200 with customerId=" ".
    expect(response.statusCode).toBe(401);
    expect(sideEffects).toHaveLength(0);
  });
});

// ── audit-2026-05-25 (I2): staff-via-customer-cookie escalation defense ──
//
// The multi-agent PR #62 review found that the customer-cookie path
// previously accepted JWTs with `userType: "staff"` and minted staff
// principals (set request.staffId / request.staffRole from the payload).
// Combined with the admin preHandler at routes/admin/index.ts admitting
// on `staffId && staffRole`, this produced a full escalation path: a
// staff JWT placed in (or leaked into) the customer `token` cookie would
// pass requireStaff and mutate as staff. The fix rejects userType:"staff"
// on the customer path AND binds JWTs to their cookie via an `aud` claim.
describe("auth-2026-05-25 (I2): staff-via-customer-cookie escalation defense", () => {
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

  it("rejects a userType:'staff' JWT on the customer cookie path", async () => {
    sideEffects.length = 0;
    // Attacker places a legitimate staff JWT in the customer `token` cookie.
    // Pre-fix this would have minted request.staffId / request.staffRole
    // from the customer-cookie path, allowing staff escalation. Post-fix,
    // the customer path early-returns on userType === "staff".
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = {
        sub: "staff_acme",
        userType: "staff",
        role: "OWNER",
        jti: "staff-jti",
        aud: "staff_token",
      };
    });

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    // The protected route checks request.customerId. The staff-typed
    // token must not populate customerId, so requireAuth gates 401.
    expect(response.statusCode).toBe(401);
    expect(sideEffects).not.toContain("protected-handler-executed");
  });

  it("accepts a customer-typed JWT carrying aud:'token' (happy path)", async () => {
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = {
        sub: "cust_aud_ok",
        userType: "customer",
        jti: "aud-ok-jti",
        aud: "token",
      };
    });
    // No revocation in this test
    const mockRedis = { get: vi.fn().mockResolvedValue(null) };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customerId).toBe("cust_aud_ok");
    expect(sideEffects).toContain("protected-handler-executed");
  });

  it("rejects a customer-typed JWT carrying aud:'staff_token' (token-mixing)", async () => {
    sideEffects.length = 0;
    // Attacker minted a fresh JWT with userType:"customer" but aud:"staff_token"
    // — token-mixing across cookie types. The aud-binding check fails,
    // customerId never gets populated, requireAuth returns 401.
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = {
        sub: "cust_aud_wrong",
        userType: "customer",
        jti: "aud-wrong-jti",
        aud: "staff_token", // wrong audience for the token cookie
      };
    });

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(401);
    expect(sideEffects).not.toContain("protected-handler-executed");
  });

  it("accepts a legacy customer JWT with aud === undefined (rollover compat)", async () => {
    // Tokens issued before the aud-binding deploy carry aud === undefined.
    // The validator treats undefined as legacy-accept during the rollover
    // window so existing signed-in sessions don't all 401 at once. After
    // the longest staff JWT TTL (8h) has elapsed post-deploy, this branch
    // can be tightened to fail-closed.
    sideEffects.length = 0;
    mockJwtVerify.mockImplementation(async function (this: { user: unknown }) {
      this.user = {
        sub: "cust_legacy_aud",
        userType: "customer",
        jti: "legacy-aud-jti",
        // aud: undefined  — explicitly omitted
      };
    });
    const mockRedis = { get: vi.fn().mockResolvedValue(null) };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const response = await server.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customerId).toBe("cust_legacy_aud");
  });
});

describe("extractAuth — staff active-check (STAFFREVOKE)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = (await buildTestServer()).app;
  });
  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    // No customer token → fall through to the staff_token path.
    mockJwtVerify.mockRejectedValue(new Error("no customer token"));
    mockRk.mockImplementation((k: string) => `ibatexas:${k}`);
    // No revocation.
    mockGetRedisClient.mockResolvedValue({ get: vi.fn().mockResolvedValue(null) });
    mockStaffJwtVerify.mockReturnValue({
      sub: "staff_1",
      userType: "staff",
      role: "OWNER",
      jti: "j1",
      aud: "staff_token",
    });
  });

  const inject = () =>
    server.inject({ method: "GET", url: "/staff-check", headers: { cookie: "staff_token=tok" } });

  it("attaches staff identity when the staff member is still active", async () => {
    mockGetStaffById.mockResolvedValue({ id: "staff_1", active: true });
    const body = (await inject()).json();
    expect(mockGetStaffById).toHaveBeenCalledWith("staff_1");
    expect(body.staffId).toBe("staff_1");
    expect(body.userType).toBe("staff");
  });

  it("does NOT attach staff identity when the staff member is deactivated (active=false)", async () => {
    mockGetStaffById.mockResolvedValue({ id: "staff_1", active: false });
    const body = (await inject()).json();
    expect(body.staffId).toBeNull();
    expect(body.userType).toBeNull();
  });

  it("does NOT attach staff identity when the staff row was deleted (getById throws)", async () => {
    mockGetStaffById.mockRejectedValue(new Error("not found"));
    const body = (await inject()).json();
    expect(body.staffId).toBeNull();
    expect(body.userType).toBeNull();
  });

  it("JWTSPLIT: verifies staff_token via the dedicated staff instance, not the customer one", async () => {
    mockGetStaffById.mockResolvedValue({ id: "staff_1", active: true });
    mockCustomerInstanceVerify.mockImplementation(() => {
      throw new Error("customer instance must not verify staff tokens");
    });
    const body = (await inject()).json();
    expect(body.staffId).toBe("staff_1");
    expect(mockStaffJwtVerify).toHaveBeenCalledWith("tok");
    expect(mockCustomerInstanceVerify).not.toHaveBeenCalled();
  });
});
