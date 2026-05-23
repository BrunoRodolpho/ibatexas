// Unit tests for /api/me routes — LGPD data export, anonymize OTP gate, 3-endpoint flow.
//
// Task 14 (M3) coverage:
//   - GET    /api/me/data                       — portability path (unchanged).
//   - POST   /api/me/data/initiate-deletion     — issues fresh OTP, marks freshness.
//   - DELETE /api/me/data?token=                — verifies OTP, builds envelope, parks DEFER.
//   - POST   /api/me/data/cancel-deletion       — clears receipt within 24h grace.
//
// The legacy single-DELETE test was replaced because the route changed shape
// (now requires `token=` query param + a fresh OTP marker). The new 3-endpoint
// flow is the contract.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockExportCustomerData = vi.hoisted(() => vi.fn());
const mockAnonymizeCustomer = vi.hoisted(() => vi.fn());
const mockAnonymizeCustomerFromEnvelope = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockSendOtp = vi.hoisted(() =>
  vi.fn(async (_args: { to: string; channel: string }) => undefined),
);
const mockVerifyOtp = vi.hoisted(() =>
  vi.fn(async (_args: { to: string; code: string }) => ({ status: "approved" as string })),
);

// Redis stub — module-scoped Map so tests can pre-seed / inspect keys.
const redisStorage = vi.hoisted(() => new Map<string, string>());
const mockRedisSet = vi.hoisted(() =>
  vi.fn(async (key: string, value: string, _opts?: { EX: number }) => {
    redisStorage.set(key, value);
    return "OK";
  }),
);
const mockRedisGet = vi.hoisted(() =>
  vi.fn(async (key: string) => redisStorage.get(key) ?? null),
);
const mockRedisDel = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    const had = redisStorage.has(key);
    redisStorage.delete(key);
    return had ? 1 : 0;
  }),
);

vi.mock("@ibatexas/domain", () => ({
  exportCustomerData: mockExportCustomerData,
  anonymizeCustomer: mockAnonymizeCustomer,
  anonymizeCustomerFromEnvelope: mockAnonymizeCustomerFromEnvelope,
  createCustomerService: () => ({
    getById: mockGetById,
  }),
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    set: mockRedisSet,
    get: mockRedisGet,
    del: mockRedisDel,
  })),
  rk: (k: string) => `ibatexas:${k}`,
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
}));

vi.mock("twilio", () => ({
  default: () => ({
    verify: {
      v2: {
        services: () => ({
          verifications: { create: mockSendOtp },
          verificationChecks: {
            create: mockVerifyOtp,
          },
        }),
      },
    },
  }),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (!customerId) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
      return;
    }
    request.customerId = customerId;
    done();
  },
}));

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  const { meRoutes } = await import("../routes/me.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(meRoutes);
  await app.ready();
  return app;
}

// ── Env stubs ──────────────────────────────────────────────────────────────────

function setupEnv() {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test_token");
  vi.stubEnv("TWILIO_VERIFY_SID", "VA_test");
  vi.stubEnv("TWILIO_OTP_CHANNEL", "whatsapp");
}

// ── Fixtures ────────────────────────────────────────────────────────────────────

const customerDataFixture = {
  customer: {
    id: "cust_01",
    phone: "+5511999887766",
    name: "Maria",
    email: null,
    source: "whatsapp",
    firstContactAt: new Date("2026-01-15T00:00:00.000Z"),
  },
  addresses: [],
  preferences: null,
  reviews: [],
  orderHistory: [],
};

// ── Tests: GET /api/me/data ────────────────────────────────────────────────────

describe("GET /api/me/data — export customer data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    setupEnv();
  });

  it("returns customer data", async () => {
    mockExportCustomerData.mockResolvedValue(customerDataFixture);

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/me/data",
        headers: { "x-customer-id": "cust_01" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.customer.id).toBe("cust_01");
      expect(mockExportCustomerData).toHaveBeenCalledWith("cust_01");
    } finally {
      await app.close();
    }
  });

  it("returns 401 when not authenticated", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/me/data" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ── Tests: POST /api/me/data/initiate-deletion ─────────────────────────────────

describe("POST /api/me/data/initiate-deletion — fresh OTP step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    setupEnv();
    mockGetById.mockResolvedValue({ id: "cust_01", phone: "+5511999887766" });
    mockSendOtp.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("sends Twilio OTP and marks freshness in Redis with 5min TTL", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
        headers: { "x-customer-id": "cust_01" },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.status).toBe("otp_sent");
      expect(body.ttlSeconds).toBe(300);

      // OTP was issued via Twilio Verify on the customer's phone.
      expect(mockSendOtp).toHaveBeenCalledTimes(1);
      const callArg = mockSendOtp.mock.calls[0][0] as { to: string; channel: string };
      expect(callArg.to).toBe("+5511999887766");

      // Freshness marker was persisted (5min TTL).
      expect(mockRedisSet).toHaveBeenCalled();
      const setArgs = mockRedisSet.mock.calls.find(
        (c) => (c[0] as string).endsWith("anonymize:otp:cust_01"),
      );
      expect(setArgs).toBeTruthy();
      expect(setArgs![2]).toEqual({ EX: 300 });
    } finally {
      await app.close();
    }
  });

  it("returns 502 on Twilio error", async () => {
    mockSendOtp.mockRejectedValueOnce(new Error("twilio failure"));

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});

// ── Tests: DELETE /api/me/data?token=… — verify + park DEFER ───────────────────

describe("DELETE /api/me/data?token= — OTP verify + DEFER park", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    setupEnv();
    mockGetById.mockResolvedValue({ id: "cust_01", phone: "+5511999887766" });
    mockVerifyOtp.mockResolvedValue({ status: "approved" as string });
  });

  it("returns 401 when no freshness marker exists (expired OTP)", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data?token=123456",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns 401 when OTP verification fails", async () => {
    redisStorage.set("ibatexas:anonymize:otp:cust_01", "1");
    mockVerifyOtp.mockResolvedValueOnce({ status: "pending" as string });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data?token=000000",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("parks DEFER + persists receipt + returns 202 on valid OTP", async () => {
    redisStorage.set("ibatexas:anonymize:otp:cust_01", "1");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data?token=123456",
        headers: { "x-customer-id": "cust_01" },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.status).toBe("deferred");
      expect(body.message).toContain("24 horas");
      expect(body.canCancelUntil).toBeTruthy();
      expect(body.intentHash).toMatch(/^[0-9a-f]{16,}$/);

      // The parked-envelope blob exists at defer:pending:{customerId}.
      const parked = redisStorage.get("ibatexas:defer:pending:cust_01");
      expect(parked).toBeTruthy();
      const parkedJson = JSON.parse(parked!) as { envelope: { kind: string; actor: { sessionId: string }; taint: string } };
      expect(parkedJson.envelope.kind).toBe("customer.anonymize");
      expect(parkedJson.envelope.actor.sessionId).toBe("cust_01");
      expect(parkedJson.envelope.taint).toBe("UNTRUSTED");

      // The customer-facing receipt exists at anonymize:pending:{customerId}.
      const receipt = redisStorage.get("ibatexas:anonymize:pending:cust_01");
      expect(receipt).toBeTruthy();

      // The OTP freshness marker was consumed.
      expect(redisStorage.get("ibatexas:anonymize:otp:cust_01")).toBeUndefined();

      // The actual destructive call did NOT run — only the kernel-adjudicated
      // envelope-typed entry point. The legacy module-level helper stays cold.
      expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("is idempotent on repeated DELETE — surfaces existing grace window", async () => {
    // Pre-seed an existing pending receipt.
    redisStorage.set("ibatexas:anonymize:otp:cust_01", "1");
    redisStorage.set(
      "ibatexas:anonymize:pending:cust_01",
      JSON.stringify({
        parkedAt: Date.now() - 60 * 60 * 1000,
        intentHash: "deadbeef",
        otpTokenHint: "12****",
      }),
    );

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data?token=123456",
        headers: { "x-customer-id": "cust_01" },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.status).toBe("deferred");
      expect(body.message).toContain("Já existe");
    } finally {
      await app.close();
    }
  });
});

// ── Tests: POST /api/me/data/cancel-deletion — clear receipt ──────────────────

describe("POST /api/me/data/cancel-deletion — clear receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    setupEnv();
  });

  it("returns 404 when no pending deletion exists", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/cancel-deletion",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("clears receipt + parked envelope and returns 200", async () => {
    redisStorage.set(
      "ibatexas:anonymize:pending:cust_01",
      JSON.stringify({
        parkedAt: Date.now() - 30 * 60 * 1000,
        intentHash: "abc123",
        otpTokenHint: "12****",
      }),
    );
    redisStorage.set("ibatexas:defer:pending:cust_01", "parked");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/cancel-deletion",
        headers: { "x-customer-id": "cust_01" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("canceled");

      // Both Redis keys were cleared.
      expect(redisStorage.get("ibatexas:anonymize:pending:cust_01")).toBeUndefined();
      expect(redisStorage.get("ibatexas:defer:pending:cust_01")).toBeUndefined();

      // anonymizeCustomer was NEVER called — cancel must abort the destructive op.
      expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
