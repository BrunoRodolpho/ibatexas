// DOM-001 — Staff OTP authentication route tests.
//
// The broad `apps/api/src/__tests__/auth-routes.test.ts` and the focused
// `auth-customer-envelope.test.ts` exercise the CUSTOMER flow. Neither touches
// the staff endpoints (`/api/auth/staff/send-otp`, `/api/auth/staff/verify-otp`)
// — those routes (the staff-only Twilio account, the staff-membership 404/403
// guards, the dedicated `server.jwt.staff` signer, and the staff_token cookie)
// were uncovered. This file tops them up against the real source behaviour.
//
// It also pins the customer `otp_abuse_suspected` branch (failCount >= 5 inside
// performCustomerOtpVerification), which the existing suite never reaches
// because it always stubs the fail counter at 1.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";
import type { FastifyRequest, FastifyReply } from "fastify";
import { authRoutes } from "../auth.js";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockAtomicIncr = vi.hoisted(() => vi.fn());
const mockVerificationCreate = vi.hoisted(() => vi.fn());
const mockVerificationCheckCreate = vi.hoisted(() => vi.fn());
const mockStaffFindByPhone = vi.hoisted(() => vi.fn());
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn());
const mockPrismaCustomerFindUniqueOrThrow = vi.hoisted(() => vi.fn());

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
  atomicIncr: mockAtomicIncr,
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    upsertFromPhone: vi.fn(),
    getById: vi.fn(),
    createFromEnvelope: mockCreateFromEnvelope,
  }),
  createStaffService: () => ({
    findByPhone: mockStaffFindByPhone,
    getById: vi.fn(),
  }),
  prisma: {
    customer: {
      findUniqueOrThrow: mockPrismaCustomerFindUniqueOrThrow,
    },
  },
}));

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    request.customerId = (request.headers["x-customer-id"] as string) ?? "cus_test";
    done();
  },
  optionalAuth: (_request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => done(),
}));

// ── Server factory ───────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(cookie);

  // Capture every payload signed via the dedicated staff signer so tests can
  // assert the role/aud claims the route stamps onto the staff JWT.
  const staffSignedPayloads: object[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).jwt = {
    sign: (payload: object) => `mock-customer-jwt-${(payload as { sub: string }).sub}`,
    decode: () => null,
    staff: {
      sign: (payload: object) => {
        staffSignedPayloads.push(payload);
        return `mock-staff-jwt-${(payload as { sub: string }).sub}`;
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any)._staffSignedPayloads = staffSignedPayloads;

  await app.register(authRoutes);
  await app.ready();
  return app;
}

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
  vi.stubEnv("STAFF_JWT_SECRET", "test-staff-jwt-secret-key");
  vi.stubEnv("NODE_ENV", "test");
}

const ACTIVE_STAFF = {
  id: "stf_01",
  phone: "+5511970000001",
  name: "Carla Gerente",
  role: "MANAGER",
  active: true,
};

// ── POST /api/auth/staff/send-otp ─────────────────────────────────────────────

describe("POST /api/auth/staff/send-otp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 and dispatches OTP via the staff Twilio account for an active staff member", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCreate.mockResolvedValue({ sid: "VE_staff_1" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511970000001" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockStaffFindByPhone).toHaveBeenCalledWith("+5511970000001");
    expect(mockVerificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+5511970000001", channel: "sms" }),
    );
  });

  it("returns 404 when the phone is not a registered staff member (no OTP sent)", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue(null);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511970000099" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("não cadastrado");
    expect(mockVerificationCreate).not.toHaveBeenCalled();
  });

  it("returns 403 when the staff account is deactivated (no OTP sent)", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue({ ...ACTIVE_STAFF, active: false });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511970000001" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("desativada");
    expect(mockVerificationCreate).not.toHaveBeenCalled();
  });

  it("returns 429 on IP rate limit before any staff lookup", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(11); // IP count > 10

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511970000001" },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().message).toContain("deste endereço");
    expect(mockStaffFindByPhone).not.toHaveBeenCalled();
    expect(mockAtomicIncr).toHaveBeenCalledTimes(1);
  });

  it("returns 429 on phone rate limit (10-minute window)", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    // IP check ok (1), phone-hash check exceeded (> 3)
    mockAtomicIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(4);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511970000001" },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().message).toContain("10 minutos");
    expect(mockStaffFindByPhone).not.toHaveBeenCalled();
  });

  it("returns 502 when the staff Twilio send fails", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCreate.mockRejectedValue(new Error("Twilio down"));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/send-otp",
      payload: { phone: "+5511970000001" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("enviar o código");
  });
});

// ── POST /api/auth/staff/verify-otp ───────────────────────────────────────────

describe("POST /api/auth/staff/verify-otp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 200 with staff identity, sets staff_token cookie, and signs a staff JWT", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511970000001", code: "123456" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "stf_01", name: "Carla Gerente", role: "MANAGER" });

    // The session lands in the dedicated staff cookie (no customer token / refresh).
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie);
    expect(cookieStr).toContain("staff_token=");
    expect(cookieStr).not.toContain("refresh_token=");

    // Failure counter cleared on success.
    expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining("otp:fail:"));

    // Staff JWT signed via the dedicated staff signer with role + staff audience.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signed = (app as any)._staffSignedPayloads as Array<{
      sub: string;
      userType: string;
      role: string;
      aud: string;
      jti: string;
    }>;
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatchObject({
      sub: "stf_01",
      userType: "staff",
      role: "MANAGER",
      aud: "staff_token",
    });
    expect(signed[0].jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns 404 for an unknown staff phone (Twilio never consulted)", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue(null);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511970000099", code: "123456" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("não cadastrado");
    expect(mockVerificationCheckCreate).not.toHaveBeenCalled();
  });

  it("returns 403 for a deactivated staff account", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue({ ...ACTIVE_STAFF, active: false });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511970000001", code: "123456" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("desativada");
    expect(mockVerificationCheckCreate).not.toHaveBeenCalled();
  });

  it("returns 429 on IP rate limit before staff lookup", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(11);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511970000001", code: "123456" },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().message).toContain("deste endereço");
    expect(mockStaffFindByPhone).not.toHaveBeenCalled();
  });

  it("returns 429 when brute-force protection is tripped (>= 5 prior failures)", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue("5") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511970000001", code: "123456" },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().message).toContain("1 hora");
    // Blocked before staff lookup / Twilio verification.
    expect(mockStaffFindByPhone).not.toHaveBeenCalled();
    expect(mockVerificationCheckCreate).not.toHaveBeenCalled();
  });

  it("returns 400 and records a failure when the code is wrong (status != approved)", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // IP check (1, ok), then recordVerifyFailure increment (2)
    mockAtomicIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    mockStaffFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCheckCreate.mockResolvedValue({ status: "pending" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511970000001", code: "000000" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("inválido");
    // No staff cookie issued on a failed verification.
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie ?? "");
    expect(cookieStr).not.toContain("staff_token=");
  });

  it("returns 400 for an expired/never-sent verification (Twilio 20404)", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCheckCreate.mockRejectedValue(
      Object.assign(new Error("Not found"), { code: 20404, status: 404 }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511970000001", code: "123456" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("expirado");
  });

  it("returns 502 on a non-20404 Twilio verification error", async () => {
    setupEnv();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockStaffFindByPhone.mockResolvedValue(ACTIVE_STAFF);
    mockVerificationCheckCreate.mockRejectedValue(
      Object.assign(new Error("Twilio 500"), { code: 60200, status: 500 }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/staff/verify-otp",
      payload: { phone: "+5511970000001", code: "123456" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("verificar código");
  });
});

// ── Customer verify-otp — otp_abuse_suspected branch (failCount >= 5) ──────────
//
// brute-force gate reads the fail counter via redis.get and blocks at >= 5, so to
// reach the abuse-warning branch the PRIOR count must be < 5 (here "4") while the
// post-attempt increment lands at exactly 5 — tripping the warn path but still
// returning the same generic 400 to the caller.

describe("POST /api/auth/verify-otp — abuse-warning branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("returns 400 and flags suspected abuse when the failure count reaches 5", async () => {
    setupEnv();
    const mockRedis = createMockRedis({ get: vi.fn().mockResolvedValue("4") });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // IP check ok (1), then recordVerifyFailure increment reaches the abuse
    // threshold (5).
    mockAtomicIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(5);
    mockVerificationCheckCreate.mockResolvedValue({ status: "pending" });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511970000050", code: "000000" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("inválido");
    // Failure was recorded (atomicIncr ran for IP + fail counter).
    expect(mockAtomicIncr).toHaveBeenCalledTimes(2);
    // No customer was upserted on a failed verification.
    expect(mockCreateFromEnvelope).not.toHaveBeenCalled();
  });
});
