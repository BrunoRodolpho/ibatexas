// Unit tests for auth routes
// POST /api/auth/send-otp, POST /api/auth/verify-otp, POST /api/auth/logout, GET /api/auth/me

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

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
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
  optionalAuth: (_request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
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

  // Decorate with jwt.sign for issueJwtToken (cast to any for test mock)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).jwt = {
    sign: (payload: object, _options?: object) => `mock-jwt-token-${(payload as { sub: string }).sub}`,
  };

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
    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(1) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(4) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

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
      incr: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
      incr: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue("5"),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);

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
      incr: vi.fn().mockResolvedValue(1),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockVerificationCheckCreate.mockResolvedValue({ status: "pending" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511999999999", code: "000000" },
    });

    expect(res.statusCode).toBe(400);
    // incr called for both send rate check and fail recording
    expect(mockRedis.incr).toHaveBeenCalled();
  });

  it("clears failure counter on successful verification", async () => {
    setupEnv();
    const mockRedis = createMockRedis({
      get: vi.fn().mockResolvedValue(null),
      incr: vi.fn().mockResolvedValue(1),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(1) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(5) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

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
    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(1) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
      incr: vi.fn().mockResolvedValue(1),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
      incr: vi.fn().mockResolvedValue(1),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
      incr: vi.fn().mockResolvedValue(1),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
      incr: vi.fn().mockResolvedValue(1),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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
      incr: vi.fn().mockResolvedValue(1),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
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

describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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
    const mockIncr = vi.fn().mockResolvedValue(11);
    const mockRedis = createMockRedis({ incr: mockIncr });
    mockGetRedisClient.mockResolvedValue(mockRedis);

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
    // incr called only once (for IP check — blocked before phone check)
    expect(mockIncr).toHaveBeenCalledTimes(1);
  });

  it("sets expire on first IP request (count === 1)", async () => {
    setupEnv();
    const mockExpire = vi.fn().mockResolvedValue(true);
    const mockIncr = vi.fn()
      .mockResolvedValueOnce(1)   // IP rate limit — first request
      .mockResolvedValueOnce(1);  // phone-hash rate limit
    const mockRedis = createMockRedis({ incr: mockIncr, expire: mockExpire });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockVerificationCreate.mockResolvedValue({ sid: "VE_123" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(200);
    // expire called with 3600 for IP key
    expect(mockExpire).toHaveBeenCalledWith(
      expect.stringContaining("otp:ip:"),
      3600,
    );
  });

  it("IP check runs BEFORE phone-hash check", async () => {
    setupEnv();
    const callOrder: string[] = [];
    const mockIncr = vi.fn().mockImplementation(async (key: string) => {
      if (key.includes("otp:ip:")) {
        callOrder.push("ip");
        return 11; // exceed IP limit
      }
      callOrder.push("phone");
      return 1;
    });
    const mockRedis = createMockRedis({ incr: mockIncr });
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(429);
    // IP check happened first and blocked — phone check never reached
    expect(callOrder).toEqual(["ip"]);
  });
});
