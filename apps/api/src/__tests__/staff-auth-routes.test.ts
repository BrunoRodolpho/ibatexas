// Unit tests for DOM-001: Staff auth routes
// POST /api/auth/staff/send-otp, POST /api/auth/staff/verify-otp

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";
import type { FastifyRequest, FastifyReply } from "fastify";
import { authRoutes } from "../routes/auth.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockUpsertFromPhone = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockFindByPhone = vi.hoisted(() => vi.fn());

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
  createStaffService: () => ({
    findByPhone: mockFindByPhone,
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

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(cookie);

  const signedPayloads: object[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).jwt = {
    sign: (payload: object, _options?: object) => {
      signedPayloads.push(payload);
      return `mock-staff-jwt-${(payload as { sub: string }).sub}`;
    },
    decode: () => null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any)._signedPayloads = signedPayloads;

  await app.register(authRoutes);
  await app.ready();
  return app;
}

// ── Mock Redis ─────────────────────────────────────────────────────────────────

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

function setupEnv() {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_sid");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
  vi.stubEnv("TWILIO_VERIFY_SID", "VA_test_verify_sid");
  vi.stubEnv("TWILIO_OTP_CHANNEL", "sms");
  vi.stubEnv("JWT_SECRET", "test-jwt-secret-key");
  vi.stubEnv("NODE_ENV", "test");
}

const ACTIVE_STAFF = {
  id: "staff_01",
  phone: "+5511999999999",
  name: "João Gerente",
  role: "MANAGER",
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const INACTIVE_STAFF = {
  ...ACTIVE_STAFF,
  id: "staff_02",
  active: false,
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/auth/staff/send-otp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 on success for active staff", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCreate.mockResolvedValue({ sid: "VE_123" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockVerificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+5511999999999", channel: "sms" }),
    );
  });

  it("returns 404 when phone is not a staff member", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockFindByPhone.mockResolvedValue(null);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511888888888" },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toContain("não cadastrado");
    expect(mockVerificationCreate).not.toHaveBeenCalled();
  });

  it("returns 403 when staff member is inactive", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockFindByPhone.mockResolvedValue(INACTIVE_STAFF);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.message).toContain("desativada");
    expect(mockVerificationCreate).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    setupEnv();
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(5);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
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
    mockFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCreate.mockRejectedValue(new Error("Twilio down"));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511999999999" },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.message).toContain("enviar o código");
  });
});

describe("POST /api/auth/staff/verify-otp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 with staff data and JWT cookie on success", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("staff_01");
    expect(body.name).toBe("João Gerente");
    expect(body.role).toBe("MANAGER");

    // JWT cookie should be set
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain("token=");
  });

  it("issues JWT with staff claims (userType=staff, role)", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payloads = (app as any)._signedPayloads as Array<{ sub: string; userType: string; role: string; jti?: string }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].sub).toBe("staff_01");
    expect(payloads[0].userType).toBe("staff");
    expect(payloads[0].role).toBe("MANAGER");
    expect(payloads[0].jti).toBeDefined();
  });

  it("returns 404 when phone not found", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockFindByPhone.mockResolvedValue(null);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511888888888", code: "123456" },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toContain("não cadastrado");
  });

  it("returns 403 when staff is inactive", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockFindByPhone.mockResolvedValue(INACTIVE_STAFF);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.message).toContain("desativada");
  });

  it("returns 400 for wrong code", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCheckCreate.mockResolvedValue({ status: "pending" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511999999999", code: "000000" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.message).toContain("inválido");
  });

  it("returns 429 when brute force blocked", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue("5") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511999999999", code: "123456" },
    });

    expect(res.statusCode).toBe(429);
    expect(mockVerificationCheckCreate).not.toHaveBeenCalled();
  });
});
