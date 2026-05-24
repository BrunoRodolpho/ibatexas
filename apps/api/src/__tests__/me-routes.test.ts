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
// P0-7 — parkDeferredIntent calls INCR/DECR/EXPIRE on the quota counter.
const mockRedisIncr = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    const cur = Number.parseInt(redisStorage.get(key) ?? "0", 10);
    const next = cur + 1;
    redisStorage.set(key, String(next));
    return next;
  }),
);
const mockRedisDecr = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    const cur = Number.parseInt(redisStorage.get(key) ?? "0", 10);
    const next = cur - 1;
    redisStorage.set(key, String(next));
    return next;
  }),
);
const mockRedisExpire = vi.hoisted(() => vi.fn(async (_key: string, _seconds: number) => 1));

// P0-X-OTP — Atomic Lua script for acquireOtpAttempt. Emulates the
// OTP_ACQUIRE_ATTEMPT_LUA script defined in anonymize-otp-gate.ts.
// Keys: [failKey, lockoutKey]; Args: [failTtl, threshold, lockoutTtl].
// Returns [allowed, count, fromSentinel].
const mockRedisEval = vi.hoisted(() =>
  vi.fn(
    async (
      _script: string,
      opts: { keys: string[]; arguments: string[] },
    ) => {
      const failKey = opts.keys[0]!;
      const lockoutKey = opts.keys[1]!;
      const threshold = Number.parseInt(opts.arguments[1] ?? "0", 10);
      const lockoutTtl = Number.parseInt(opts.arguments[2] ?? "0", 10);
      // Fast-fail: lockout sentinel exists.
      if (redisStorage.has(lockoutKey)) {
        const cur = Number.parseInt(redisStorage.get(failKey) ?? "0", 10);
        return [0, cur, 1];
      }
      const cur = Number.parseInt(redisStorage.get(failKey) ?? "0", 10);
      const next = cur + 1;
      redisStorage.set(failKey, String(next));
      if (next > threshold) {
        // Set the lockout sentinel (TTL irrelevant for Map stub).
        redisStorage.set(lockoutKey, "1");
        void lockoutTtl;
        return [0, next, 0];
      }
      return [1, next, 0];
    },
  ),
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
    incr: mockRedisIncr,
    decr: mockRedisDecr,
    expire: mockRedisExpire,
    eval: mockRedisEval,
  })),
  rk: (k: string) => `ibatexas:${k}`,
}));

// audit-2026-05-24 P0-1: re-export the real `parkDeferredIntentWithNxGuard`
// from the leaf module so me.ts routes through the NX-guarded wrapper
// (the brief's gap — before this fix, me.ts called the framework primitive
// directly and a second DEFER for the same customerId could silently
// overwrite the first parked envelope).
vi.mock("@ibatexas/llm-provider", async () => {
  const real = (await vi.importActual(
    "../../../../packages/llm-provider/src/park-nx.js",
  )) as Record<string, unknown>;
  return {
    getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
    parkDeferredIntentWithNxGuard: real.parkDeferredIntentWithNxGuard,
    PARK_COLLISION_REFUSAL_PT_BR: real.PARK_COLLISION_REFUSAL_PT_BR,
    setDeferQuotaExceededHook: real.setDeferQuotaExceededHook,
    ParkVerificationFieldsMissingError: real.ParkVerificationFieldsMissingError,
  };
});

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

// ── Tests: POST /api/me/data/send-otp ───────────────────────────────────────

describe("POST /api/me/data/send-otp — OTP issue step (W4 P0-11)", () => {
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
        url: "/api/me/data/send-otp",
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
        url: "/api/me/data/send-otp",
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

  it("[P0-11] refuses with 429 during cancel-cooldown window", async () => {
    redisStorage.set("ibatexas:anonymize:cancel-cooldown:cust_01", "1");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/send-otp",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().message).toContain("cancelou");
      expect(mockSendOtp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("[P0-11] refuses with 429 when brute-force counter at threshold", async () => {
    redisStorage.set("ibatexas:anonymize:fail:cust_01", "5");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/send-otp",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().message).toContain("Excesso de tentativas");
      expect(mockSendOtp).not.toHaveBeenCalled();
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
        url: "/api/me/data/send-otp",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});

// ── Tests: POST /api/me/data/verify-otp (W4 P0-11) ─────────────────────────

describe("POST /api/me/data/verify-otp — OTP verify + brute-force counter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    setupEnv();
    mockGetById.mockResolvedValue({ id: "cust_01", phone: "+5511999887766" });
    mockVerifyOtp.mockResolvedValue({ status: "approved" as string });
    // Pre-seed the OTP-sent marker so verify-otp doesn't fast-fail.
    redisStorage.set("ibatexas:anonymize:otp:cust_01", "1");
  });

  it("returns 401 when freshness marker missing", async () => {
    redisStorage.delete("ibatexas:anonymize:otp:cust_01");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { token: "123456" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("sets the 60s verified-marker on success and resets failure counter", async () => {
    redisStorage.set("ibatexas:anonymize:fail:cust_01", "3");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { token: "123456" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("verified");
      expect(res.json().ttlSeconds).toBe(60);

      // Verified-marker present with 60s TTL.
      const setArgs = mockRedisSet.mock.calls.find(
        (c) => (c[0] as string).endsWith("anonymize:otp_verified:cust_01"),
      );
      expect(setArgs).toBeTruthy();
      expect(setArgs![2]).toEqual({ EX: 60 });

      // Failure counter cleared.
      expect(redisStorage.get("ibatexas:anonymize:fail:cust_01")).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("[P0-11] increments brute-force counter on failed verify", async () => {
    mockVerifyOtp.mockResolvedValue({ status: "pending" as string });

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { token: "000000" },
      });
      expect(res.statusCode).toBe(401);

      // Counter went from missing to 1.
      expect(redisStorage.get("ibatexas:anonymize:fail:cust_01")).toBe("1");
    } finally {
      await app.close();
    }
  });

  it("[P0-11 / P0-X-OTP] 6 failed verifies → 429 lockout (count > threshold)", async () => {
    // P0-X-OTP semantic: acquireOtpAttempt INCRs the counter FIRST and
    // refuses when count > THRESHOLD. Attempts 1-5 are allowed (count=
    // 1..5 each ≤ threshold=5), Twilio is called and rejects → 401.
    // The 6th attempt INCRs to 6 → locked_out → 429, sentinel set; from
    // then on every attempt fast-fails without hitting Twilio.
    //
    // Pre-P0-X-OTP this assertion was "after 5 → 429" because the OLD
    // pre-check `failsBefore >= THRESHOLD` tripped on the 5th GET (when
    // the prior 4 INCRs had landed). The atomic Lua's post-INCR check
    // is the right semantic: we lock out when count EXCEEDS threshold,
    // not when it hits it.
    mockVerifyOtp.mockResolvedValue({ status: "pending" as string });

    const app = await buildTestServer();
    try {
      // 5 failed attempts — all return 401 (count = 1..5, ≤ threshold).
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/me/data/verify-otp",
          headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
          payload: { token: "000000" },
        });
        expect(res.statusCode).toBe(401);
      }
      // 6th attempt → INCR to 6 → locked_out → 429. Sentinel SET.
      mockVerifyOtp.mockClear();
      const res6 = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { token: "000000" },
      });
      expect(res6.statusCode).toBe(429);
      expect(res6.json().message).toContain("Excesso de tentativas");
      // Twilio NOT called on the lockout attempt — acquireOtpAttempt
      // refused before Twilio.
      expect(mockVerifyOtp).not.toHaveBeenCalled();

      // 7th attempt → sentinel exists → 429 fast-fail.
      const res7 = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { token: "123456" },
      });
      expect(res7.statusCode).toBe(429);
      expect(mockVerifyOtp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("[P0-11] brute force resets after 30min (TTL expiry simulated)", async () => {
    mockVerifyOtp.mockResolvedValue({ status: "pending" as string });

    const app = await buildTestServer();
    try {
      // 5 failed attempts.
      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: "POST",
          url: "/api/me/data/verify-otp",
          headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
          payload: { token: "000000" },
        });
      }
      // Locked out.
      expect(redisStorage.get("ibatexas:anonymize:fail:cust_01")).toBe("5");

      // Simulate 30min TTL expiry: the redis key vanishes.
      redisStorage.delete("ibatexas:anonymize:fail:cust_01");

      // Customer can verify again — but we need a successful OTP this time.
      mockVerifyOtp.mockResolvedValue({ status: "approved" as string });
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": "cust_01", "content-type": "application/json" },
        payload: { token: "123456" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("verified");
    } finally {
      await app.close();
    }
  });
});

// ── Tests: POST /api/me/data/initiate-deletion (W4 P0-11) ──────────────────

describe("POST /api/me/data/initiate-deletion — requires fresh verify-otp (W4 P0-11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    setupEnv();
    mockGetById.mockResolvedValue({ id: "cust_01", phone: "+5511999887766" });
  });

  it("[P0-11] returns 401 when no verified-otp marker (stolen-JWT defense)", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain("Verificação expirada");
    } finally {
      await app.close();
    }
  });

  it("[P0-11] returns 429 during cancel-cooldown window", async () => {
    redisStorage.set("ibatexas:anonymize:cancel-cooldown:cust_01", "1");
    redisStorage.set("ibatexas:anonymize:otp_verified:cust_01", "1");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().message).toContain("cancelou");
    } finally {
      await app.close();
    }
  });

  it("parks DEFER + persists receipt + consumes verified-marker", async () => {
    redisStorage.set("ibatexas:anonymize:otp_verified:cust_01", "1");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
        headers: { "x-customer-id": "cust_01" },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.status).toBe("deferred");
      expect(body.message).toContain("24 horas");

      // Parked envelope blob.
      const parked = redisStorage.get("ibatexas:defer:pending:cust_01");
      expect(parked).toBeTruthy();

      // Customer-facing receipt.
      expect(redisStorage.get("ibatexas:anonymize:pending:cust_01")).toBeTruthy();

      // Verified marker was consumed.
      expect(redisStorage.get("ibatexas:anonymize:otp_verified:cust_01")).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("idempotent on existing pending deletion", async () => {
    redisStorage.set("ibatexas:anonymize:otp_verified:cust_01", "1");
    redisStorage.set(
      "ibatexas:anonymize:pending:cust_01",
      JSON.stringify({
        parkedAt: Date.now() - 60 * 60 * 1000,
        intentHash: "deadbeef",
        otpTokenHint: "verified",
      }),
    );

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().message).toContain("Já existe");
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

  it("[P0-11] legacy DELETE applies brute-force counter on failed OTP", async () => {
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
      // Counter incremented.
      expect(redisStorage.get("ibatexas:anonymize:fail:cust_01")).toBe("1");
    } finally {
      await app.close();
    }
  });

  it("[P0-11] legacy DELETE refuses when locked out", async () => {
    redisStorage.set("ibatexas:anonymize:otp:cust_01", "1");
    redisStorage.set("ibatexas:anonymize:fail:cust_01", "5");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data?token=123456",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().message).toContain("Excesso de tentativas");
      expect(mockVerifyOtp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("[P0-11] legacy DELETE refuses during cancel-cooldown", async () => {
    redisStorage.set("ibatexas:anonymize:otp:cust_01", "1");
    redisStorage.set("ibatexas:anonymize:cancel-cooldown:cust_01", "1");

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data?token=123456",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().message).toContain("cancelou");
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

  it("[P0-11] sets the 30-min cancel-cooldown after cancel", async () => {
    redisStorage.set(
      "ibatexas:anonymize:pending:cust_01",
      JSON.stringify({
        parkedAt: Date.now() - 30 * 60 * 1000,
        intentHash: "abc123",
        otpTokenHint: "verified",
      }),
    );

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/cancel-deletion",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(200);

      // The cancel-cooldown marker was set with the 30-min TTL.
      const setArgs = mockRedisSet.mock.calls.find(
        (c) => (c[0] as string).endsWith("anonymize:cancel-cooldown:cust_01"),
      );
      expect(setArgs).toBeTruthy();
      expect(setArgs![2]).toEqual({ EX: 30 * 60 });
    } finally {
      await app.close();
    }
  });
});
