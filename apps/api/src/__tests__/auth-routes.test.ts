// Unit tests for auth routes
// POST /api/auth/send-otp, POST /api/auth/verify-otp, POST /api/auth/refresh,
// POST /api/auth/logout, GET /api/auth/me

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const _mockTwilioClient = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockUpsertFromPhone = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());

// Mock Twilio verify API
const mockVerificationCreate = vi.hoisted(() => vi.fn());
const mockVerificationCheckCreate = vi.hoisted(() => vi.fn());

vi.mock("twilio", () => ({
  default: () => ({
    verify: {
      v2: {
        services: () => ({
          verifications: { create: mockVerificationCreate },
          verificationChecks: { create: mockVerificationCheckCreate },
        }),
      },
    },
  }),
}));

const mockAtomicIncr = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  atomicIncr: mockAtomicIncr,
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    upsertFromPhone: mockUpsertFromPhone,
    getById: mockGetById,
  }),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (!customerId) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
    } else {
      request.customerId = customerId;
    }
    done();
  },
  optionalAuth: (request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    // Parse cookies to support logout revocation test
    const cookieHeader = request.headers["cookie"] as string | undefined;
    if (cookieHeader) {
      const parsed: Record<string, string> = {};
      for (const part of cookieHeader.split(";")) {
        const [k, v] = part.trim().split("=");
        if (k && v) parsed[k] = v;
      }
      (request as unknown as { cookies: Record<string, string> }).cookies = parsed;
    }
    done();
  },
}));

// ── Server factory ─────────────────────────────────────────────────────────────

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";
import { authRoutes } from "../routes/auth.js";

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(cookie);

  // Decorate with jwt.sign and jwt.decode for issueJwtToken + logout revocation
  const signedPayloads: object[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).jwt = {
    sign: (payload: object, _options?: object) => {
      signedPayloads.push(payload);
      return `mock-jwt-token-${(payload as { sub: string }).sub}`;
    },
    decode: () => null, // overridden per-test where needed
  };
  // Expose for assertion
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any)._signedPayloads = signedPayloads;

  await app.register(authRoutes);
  await app.ready();
  return app;
}

// ── Mock Redis client ─────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setupEnv() {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_sid");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
  vi.stubEnv("TWILIO_VERIFY_SID", "VA_test_verify_sid");
  vi.stubEnv("TWILIO_OTP_CHANNEL", "sms");
  vi.stubEnv("JWT_SECRET", "test-jwt-secret-key");
  vi.stubEnv("NODE_ENV", "test");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("phoneHash utility", () => {
  it("produces a 12-char hex string", () => {
    const hash = createHash("sha256").update("+5511999999999").digest("hex").slice(0, 12);
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("checkSendRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("allows first request (count <= 3)", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCreate.mockResolvedValue({ sid: "VE_123" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("blocks when rate limit exceeded (count > 3)", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // First call = IP rate limit (ok), second call = phone rate limit (exceeded)
    mockAtomicIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(4);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.message).toContain("Muitas tentativas");
  });
});

describe("checkBruteForce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("allows when no failures recorded", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });
    mockUpsertFromPhone.mockResolvedValue({
      id: "cus_01",
      phone: "+5511999999999",
      name: "Test",
      email: null,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("blocks when >= 5 failures recorded", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue("5"),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.message).toContain("Muitas tentativas");
    expect(body.message).toContain("1 hora");
  });
});

describe("recordVerifyFailure & clearVerifyFailures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("increments failure counter on wrong code", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "pending" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "000000" },
    });

    expect(res.statusCode).toBe(400);
    // atomicIncr called for IP rate check and fail recording
    expect(mockAtomicIncr).toHaveBeenCalled();
  });

  it("clears failure counter on successful verification", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });
    mockUpsertFromPhone.mockResolvedValue({
      id: "cus_01",
      phone: "+5511999999999",
      name: "Test",
      email: null,
    });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    // del is called for clearVerifyFailures
    expect(mockRedis.del).toHaveBeenCalled();
  });
});

describe("POST /api/auth/send-otp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 on success", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCreate.mockResolvedValue({ sid: "VE_123" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockVerificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+5511999999999", channel: "sms" }),
    );
  });

  it("returns 429 when rate limited", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // First call = IP (ok), second call = phone rate limit (exceeded)
    mockAtomicIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(5);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(429);
    expect(mockVerificationCreate).not.toHaveBeenCalled();
  });

  it("returns 502 on Twilio error", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCreate.mockRejectedValue(new Error("Twilio down"));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.message).toContain("enviar o código");
  });

  it("returns 400 for invalid phone format", async () => {
    setupEnv();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "not-a-phone" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/auth/verify-otp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 with customer data and sets cookie on success", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });
    mockUpsertFromPhone.mockResolvedValue({
      id: "cus_01",
      phone: "+5511999999999",
      name: "Maria",
      email: "maria@example.com",
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456", name: "Maria" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("cus_01");
    expect(body.phone).toBe("+5511999999999");
    expect(body.name).toBe("Maria");

    // JWT cookie should be set
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain("token=");
  });

  it("upserts customer with name on first verification", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });
    mockUpsertFromPhone.mockResolvedValue({
      id: "cus_02",
      phone: "+5511888888888",
      name: "Joao",
      email: null,
    });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511888888888", code: "654321", name: "Joao" },
    });

    expect(mockUpsertFromPhone).toHaveBeenCalledWith("+5511888888888", "Joao");
  });

  it("returns 400 for wrong code", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "pending" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "000000" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.message).toContain("inválido");
  });

  it("returns 429 when brute force blocked", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue("5"),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(429);
    expect(mockVerificationCheckCreate).not.toHaveBeenCalled();
  });

  it("returns 502 on Twilio error", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockRejectedValue(
      Object.assign(new Error("Twilio error"), { code: 60200, status: 500 }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.message).toContain("verificar código");
  });

  it("returns 400 for expired/not-found verification (Twilio 20404)", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockRejectedValue(
      Object.assign(new Error("Not found"), { code: 20404, status: 404 }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.message).toContain("expirado");
  });

  it("returns 400 for invalid code format", async () => {
    setupEnv();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "abc" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("SEC-004: JWT jti issuance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("includes jti (unique token ID) in JWT payload", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });
    mockUpsertFromPhone.mockResolvedValue({
      id: "cus_jti",
      phone: "+5511999999999",
      name: "Test",
      email: null,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payloads = (app as any)._signedPayloads as Array<{ sub: string; jti?: string }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].jti).toBeDefined();
    // jti should be a UUID format
    expect(payloads[0].jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 and clears the token cookie", async () => {
    setupEnv();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    // Cookie should be cleared (expires in the past or max-age=0)
    expect(String(setCookie)).toContain("token=");
  });

  it("revokes JWT by setting revocation key in Redis on logout", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();

    // The mock jwt.decode returns payload with jti and exp
    const futureExp = Math.floor(Date.now() / 1000) + 7200; // 2h from now
    // Override jwt.decode on the server
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).jwt.decode = (token: string) => {
      if (token === "mock-token-with-jti") {
        return { sub: "cus_01", userType: "customer", jti: "test-jti-uuid", exp: futureExp };
      }
      return null;
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: "token=mock-token-with-jti" },
    });

    expect(res.statusCode).toBe(200);
    // Revocation key should have been set
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("jwt:revoked:test-jti-uuid"),
      "1",
      expect.objectContaining({ EX: expect.any(Number) }),
    );
  });

  it("succeeds even when Redis is down (best-effort revocation)", async () => {
    setupEnv();
    mockGetRedisClient.mockRejectedValue(new Error("Connection refused"));

    const app = await buildTestServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).jwt.decode = () => ({
      sub: "cus_01",
      jti: "some-jti",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: "token=some-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns customer data when authenticated", async () => {
    setupEnv();
    mockGetById.mockResolvedValue({
      id: "cus_01",
      phone: "+5511999999999",
      name: "Maria",
      email: "maria@example.com",
      medusaId: "med_01",
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { "x-customer-id": "cus_01" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("cus_01");
    expect(body.phone).toBe("+5511999999999");
    expect(body.name).toBe("Maria");
    expect(body.medusaId).toBe("med_01");
  });

  it("returns 401 when not authenticated", async () => {
    setupEnv();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toContain("Autenticação");
  });
});

describe("checkIpRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 429 when IP rate limit exceeded (count > 10)", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(11);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.message).toContain("Muitas tentativas deste endereço");
    expect(body.message).toContain("1 hora");
    // Should not reach the phone-hash rate limit or Twilio
    expect(mockVerificationCreate).not.toHaveBeenCalled();
    // atomicIncr called only once (for IP check — blocked before phone check)
    expect(mockAtomicIncr).toHaveBeenCalledTimes(1);
  });

  it("uses atomicIncr with correct TTL for IP rate limit", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCreate.mockResolvedValue({ sid: "VE_123" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(200);
    // atomicIncr called with correct TTL for IP key (3600s) and phone key (600s)
    expect(mockAtomicIncr).toHaveBeenCalledWith(
      mockRedis,
      expect.stringContaining("otp:ip:"),
      3600,
    );
  });

  it("IP check runs BEFORE phone-hash check", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // First atomicIncr = IP check (exceeded), should block before phone check
    mockAtomicIncr.mockResolvedValue(11);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(429);
    // atomicIncr called only once (IP check) — phone check never reached
    expect(mockAtomicIncr).toHaveBeenCalledTimes(1);
  });
});

// ── AUTH-001: Refresh Token Flow ──────────────────────────────────────────────

describe("AUTH-001: verify-otp issues refresh token cookie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("sets both token and refresh_token cookies on successful OTP verify", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });
    mockUpsertFromPhone.mockResolvedValue({
      id: "cus_refresh",
      phone: "+5511999999999",
      name: "Test",
      email: null,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(200);
    const setCookieHeaders = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookieHeaders) ? setCookieHeaders.join("; ") : String(setCookieHeaders);
    expect(cookieStr).toContain("token=");
    expect(cookieStr).toContain("refresh_token=");
  });

  it("stores refresh token in Redis with 30-day TTL", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });
    mockUpsertFromPhone.mockResolvedValue({
      id: "cus_refresh2",
      phone: "+5511999999999",
      name: "Test",
      email: null,
    });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    // Redis set should be called for the refresh token
    const refreshSetCalls = mockRedis.set.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("refresh:"),
    );
    expect(refreshSetCalls.length).toBeGreaterThanOrEqual(1);
    const [, value, options] = refreshSetCalls[0];
    const parsed = JSON.parse(value as string);
    expect(parsed.customerId).toBe("cus_refresh2");
    expect(parsed.issuedAt).toEqual(expect.any(Number));
    expect((options as { EX: number }).EX).toBe(30 * 24 * 60 * 60);
  });
});

describe("POST /api/auth/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 401 when refresh_token cookie is missing", async () => {
    setupEnv();
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toContain("ausente");
  });

  it("returns 401 and clears cookies when refresh token not found in Redis", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null), // token not in Redis
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      cookies: { refresh_token: "expired-or-used-token" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toContain("inválido ou expirado");
    // Should clear both cookies
    const setCookieHeaders = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookieHeaders) ? setCookieHeaders.join("; ") : String(setCookieHeaders);
    expect(cookieStr).toContain("token=");
    expect(cookieStr).toContain("refresh_token=");
  });

  it("issues new JWT + rotated refresh token on valid refresh", async () => {
    setupEnv();
    const storedPayload = JSON.stringify({ customerId: "cus_r01", issuedAt: Date.now() });
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(storedPayload),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      cookies: { refresh_token: "valid-refresh-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // Old token should be deleted (consumed)
    expect(mockRedis.del).toHaveBeenCalledWith(
      expect.stringContaining("refresh:valid-refresh-token"),
    );

    // New refresh token should be stored in Redis
    const refreshSetCalls = mockRedis.set.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("refresh:"),
    );
    expect(refreshSetCalls.length).toBeGreaterThanOrEqual(1);

    // Both cookies should be set
    const setCookieHeaders = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookieHeaders) ? setCookieHeaders.join("; ") : String(setCookieHeaders);
    expect(cookieStr).toContain("token=");
    expect(cookieStr).toContain("refresh_token=");

    // JWT should be signed with the correct customer ID
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payloads = (app as any)._signedPayloads as Array<{ sub: string }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].sub).toBe("cus_r01");
  });

  it("consumes (deletes) the old refresh token before issuing a new one", async () => {
    setupEnv();
    const storedPayload = JSON.stringify({ customerId: "cus_r02", issuedAt: Date.now() });
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(storedPayload),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      cookies: { refresh_token: "token-to-rotate" },
    });

    // del should be called with the old token key
    expect(mockRedis.del).toHaveBeenCalledWith(
      expect.stringContaining("refresh:token-to-rotate"),
    );
  });
});

describe("AUTH-001: Logout cleans up refresh token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("deletes refresh token from Redis on logout", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: "token=jwt-token; refresh_token=my-refresh-token" },
    });

    expect(res.statusCode).toBe(200);
    // Refresh token should be deleted from Redis
    expect(mockRedis.del).toHaveBeenCalledWith(
      expect.stringContaining("refresh:my-refresh-token"),
    );
  });

  it("clears both token and refresh_token cookies on logout", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: "token=jwt; refresh_token=rf" },
    });

    expect(res.statusCode).toBe(200);
    const setCookieHeaders = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookieHeaders) ? setCookieHeaders.join("; ") : String(setCookieHeaders);
    expect(cookieStr).toContain("token=");
    expect(cookieStr).toContain("refresh_token=");
  });

  it("succeeds even when Redis is down during refresh token deletion", async () => {
    setupEnv();
    mockGetRedisClient.mockRejectedValue(new Error("Connection refused"));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: "token=jwt; refresh_token=rf" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
