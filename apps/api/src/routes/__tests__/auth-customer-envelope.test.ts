// W7 P3 — focused envelope-routing tests for OTP-verify customer.create
//
// The broader `apps/api/src/__tests__/auth-routes.test.ts` covers the
// existing end-to-end semantics (tokens, cookies, response shape) with a
// back-compat shim that routes its `mockUpsertFromPhone` calls through
// the new envelope path. This file asserts the envelope-routing details
// directly:
//
//   - The route invokes `customerSvc.createFromEnvelope` with:
//       * `envelope.kind = "customer.create"`
//       * `envelope.taint = "SYSTEM"` (clears pack's systemMinimum floor)
//       * `envelope.actor.principal = "system"`
//       * `envelope.actor.sessionId = "auth-verify-otp:<phoneHash>"`
//       * `envelope.payload.source = "otp"`
//       * `envelope.payload.phoneHash` matches sha256(phone).slice(0,12)
//       * `envelope.nonce` is deterministic per phone hash (replay-safe)
//   - `extras` carries the raw phone (for the upsert) and the name when present.
//   - The OTP-verify response shape `{ id, phone, name, email }` is
//     preserved when the kernel EXECUTEs.
//   - A kernel REFUSE returns 500 (the system-seed path should never
//     be refused in practice; if it is, operators must investigate).

import { createHash } from "node:crypto";
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

// ── Hoisted mocks ────────────────────────────────────────────────────────

const mockCreateFromEnvelope = vi.hoisted(() => vi.fn());
const mockPrismaCustomerFindUniqueOrThrow = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockAtomicIncr = vi.hoisted(() => vi.fn());
const mockVerificationCheckCreate = vi.hoisted(() => vi.fn());

vi.mock("twilio", () => ({
  default: () => ({
    verify: {
      v2: {
        services: () => ({
          verifications: { create: vi.fn() },
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
  prisma: {
    customer: {
      findUniqueOrThrow: mockPrismaCustomerFindUniqueOrThrow,
    },
  },
}));

vi.mock("../../middleware/auth.js", () => ({
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
  optionalAuth: (_request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => done(),
}));

// ── Server factory ──────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(cookie);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).jwt = {
    sign: (payload: object) => `mock-jwt-${(payload as { sub: string }).sub}`,
    decode: () => null,
  };

  await app.register(authRoutes);
  await app.ready();
  return app;
}

function createMockRedis() {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(1),
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

// ── Tests ────────────────────────────────────────────────────────────────

describe("auth.ts P3 — customer.create envelope routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockAtomicIncr.mockResolvedValue(1);
    mockVerificationCheckCreate.mockResolvedValue({ status: "approved" });
  });

  it("routes through createFromEnvelope with system-actor envelope on verify-otp", async () => {
    const phone = "+5511999999999";
    const expectedHash = createHash("sha256").update(phone).digest("hex").slice(0, 12);

    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { id: "cus_01" },
    });
    mockPrismaCustomerFindUniqueOrThrow.mockResolvedValue({
      id: "cus_01",
      phone,
      name: "Joao",
      email: null,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone, code: "123456", name: "Joao" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreateFromEnvelope).toHaveBeenCalledOnce();

    const [envelope, state, extras] = mockCreateFromEnvelope.mock.calls[0] as [
      {
        kind: string;
        taint: string;
        actor: { principal: string; sessionId: string };
        payload: { phoneHash: string; source: string };
        nonce: string;
      },
      { ctx: { actor: { principal: string }; otpFresh: boolean } },
      { phone: string; name?: string },
    ];

    // Envelope is system-seed shape per pack-customer-onboarding's
    // systemMinimum: "SYSTEM" floor for customer.create.
    expect(envelope.kind).toBe("customer.create");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.actor.sessionId).toBe(`auth-verify-otp:${expectedHash}`);
    expect(envelope.payload.phoneHash).toBe(expectedHash);
    expect(envelope.payload.source).toBe("otp");

    // Nonce is deterministic per phone hash for replay-safety.
    expect(envelope.nonce).toBe(`auth-verify-otp:${expectedHash}`);

    // State: post-OTP completion path — otpFresh is true.
    expect(state.ctx.actor.principal).toBe("system");
    expect(state.ctx.otpFresh).toBe(true);

    // Raw phone + name reach the executor via `extras` so the inner
    // upsert can write them to Prisma (the payload only carries phoneHash).
    expect(extras.phone).toBe(phone);
    expect(extras.name).toBe("Joao");
  });

  it("preserves response shape after envelope EXECUTE", async () => {
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { id: "cus_99" },
    });
    mockPrismaCustomerFindUniqueOrThrow.mockResolvedValue({
      id: "cus_99",
      phone: "+5511888888888",
      name: "Maria",
      email: "maria@example.com",
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511888888888", code: "123456", name: "Maria" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      id: "cus_99",
      phone: "+5511888888888",
      name: "Maria",
      email: "maria@example.com",
    });
  });

  it("returns 500 when kernel REFUSEs the system-seed envelope", async () => {
    mockCreateFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "taint_below_floor",
          userFacing: "Não foi possível concluir.",
        },
      },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511777777777", code: "123456" },
    });

    expect(res.statusCode).toBe(500);
    expect(mockPrismaCustomerFindUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("omits `name` from extras when not provided", async () => {
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { id: "cus_42" },
    });
    mockPrismaCustomerFindUniqueOrThrow.mockResolvedValue({
      id: "cus_42",
      phone: "+5511666666666",
      name: null,
      email: null,
    });

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/auth/verify-otp",
      payload: { phone: "+5511666666666", code: "123456" },
    });

    const [, , extras] = mockCreateFromEnvelope.mock.calls[0] as [
      unknown,
      unknown,
      { phone: string; name?: string },
    ];
    expect(extras.phone).toBe("+5511666666666");
    expect(extras.name).toBeUndefined();
  });
});
