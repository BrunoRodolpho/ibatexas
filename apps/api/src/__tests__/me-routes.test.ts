// Unit tests for /api/me routes — LGPD data export, anonymize OTP gate, 3-endpoint flow.
//
// Coverage:
//   - GET    /api/me/data                       — portability path (unchanged).
//   - POST   /api/me/data/send-otp              — issues fresh OTP, marks freshness.
//   - POST   /api/me/data/verify-otp            — verifies code, 60s verified window.
//   - POST   /api/me/data/initiate-deletion     — requires fresh verify, parks DEFER (24h grace).
//   - DELETE /api/me/data                       — WS7: IMMEDIATE erasure (LGPD Option B, D-25):
//       adjudicates customer.anonymize with immediateErasure → EXECUTE now, no OTP/grace.
//   - POST   /api/me/data/cancel-deletion       — clears receipt within 24h grace.
//
// WS7 note: the DELETE contract changed from the legacy OTP→DEFER single-step to
// immediate erasure; the multi-step OTP+grace flow remains for clients that want it.

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
  vi.fn(
    async (
      key: string,
      value: string,
      opts?: { EX?: number; NX?: boolean },
    ) => {
      // audit-2026-05-24 P0-3 — the anonymize-active-lock acquire uses
      // `SET key value EX ttl NX`. node-redis returns "OK" on acquire,
      // null on collision; emulate that semantic here so tests of the
      // cancel-deletion + grace-resolver race against this mock behave
      // like real Redis.
      if (opts?.NX === true) {
        if (redisStorage.has(key)) {
          return null;
        }
        redisStorage.set(key, value);
        return "OK";
      }
      redisStorage.set(key, value);
      return "OK";
    },
  ),
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
//
// audit-2026-05-24 P0-3 — also emulates the anonymize-active-lock's
// ownership-checked RELEASE_LOCK_SCRIPT (single-key, single-arg). We
// dispatch by the shape of the call (single key + single arg →
// release-lock; two keys + three args → OTP acquire).
const mockRedisEval = vi.hoisted(() =>
  vi.fn(
    async (
      _script: string,
      opts: { keys: string[]; arguments: string[] },
    ) => {
      // Anonymize-active-lock conditional DEL (single key, single arg).
      if (opts.keys.length === 1 && opts.arguments.length === 1) {
        const key = opts.keys[0]!;
        const expectedValue = opts.arguments[0]!;
        const stored = redisStorage.get(key);
        if (stored === expectedValue) {
          redisStorage.delete(key);
          return 1;
        }
        return 0;
      }
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
  // WS7: the immediate-erasure DELETE runs anonymizeCustomer under a
  // per-customer lock. The hermetic stub just invokes the critical section.
  withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
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

// ── Tests: DELETE /api/me/data — IMMEDIATE erasure (LGPD Option B, D-25) ───────
//
// WS7 (claustrum-on-dev): the DELETE handler now performs IMMEDIATE erasure —
// it adjudicates `customer.anonymize` with `state.ctx.immediateErasure: true`
// through the customer-intent gateway (real `adjudicate` + the real
// `customerOnboardingPolicyBundle`), which skips the fresh-OTP guard + the 24h
// grace DEFER and EXECUTEs `anonymizeCustomer` NOW under a per-customer lock.
// No OTP, no token query param, no DEFER. The multi-step OTP+grace flow
// (send-otp / verify-otp / initiate-deletion / cancel-deletion) is unchanged
// and covered by the describe blocks above/below.

describe("DELETE /api/me/data — immediate erasure (LGPD Option B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    setupEnv();
    mockGetById.mockResolvedValue({ id: "cust_01", phone: "+5511999887766" });
    mockAnonymizeCustomer.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data",
      });
      expect(res.statusCode).toBe(401);
      expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("EXECUTEs anonymize immediately (no OTP, no DEFER) and returns 200", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data",
        headers: { "x-customer-id": "cust_01" },
      });

      // EXECUTE → 200 with the LGPD success copy.
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain("anonimizados");

      // The destructive call ran NOW for the authenticated customer.
      expect(mockAnonymizeCustomer).toHaveBeenCalledTimes(1);
      expect(mockAnonymizeCustomer).toHaveBeenCalledWith("cust_01");

      // It is IMMEDIATE — no DEFER park, no customer-facing grace receipt.
      expect(redisStorage.get("ibatexas:defer:pending:cust_01")).toBeUndefined();
      expect(redisStorage.get("ibatexas:anonymize:pending:cust_01")).toBeUndefined();

      // No OTP was required (no token query param, no Twilio verify check).
      expect(mockVerifyOtp).not.toHaveBeenCalled();

      // The legacy envelope-typed grace entry point stays cold — the immediate
      // path runs the destructive call via anonymizeCustomer under the lock.
      expect(mockAnonymizeCustomerFromEnvelope).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does NOT require an OTP freshness marker or token", async () => {
    // No anonymize:otp marker seeded, no ?token — pre-cutover this 401'd.
    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/me/data",
        headers: { "x-customer-id": "cust_01" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockAnonymizeCustomer).toHaveBeenCalledWith("cust_01");
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

  // ── audit-2026-05-24 P0-3 — anonymize-active mutex ──────────────────────

  it("[P0-3] returns 409 + pt-BR copy when the resolver already holds the anonymize-active lock", async () => {
    // Pre-seed the receipt (cancel must pass the 404 check) AND
    // pre-acquire the active-lock as if the grace resolver SETNX'd
    // first (its value is prefixed with `resolving:`).
    redisStorage.set(
      "ibatexas:anonymize:pending:cust_01",
      JSON.stringify({
        parkedAt: Date.now() - 23 * 60 * 60 * 1000, // T+23h, close to grace
        intentHash: "abc123",
        otpTokenHint: "verified",
      }),
    );
    redisStorage.set(
      "ibatexas:anonymize:active:cust_01",
      "resolving:uuid-from-grace-resolver",
    );

    const app = await buildTestServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/data/cancel-deletion",
        headers: { "x-customer-id": "cust_01" },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe("Conflict");
      // pt-BR copy — match the audit brief's prescribed wording.
      expect(body.message).toContain("Solicitação de anonimização já em andamento");

      // The receipt MUST NOT be cleared — we never entered the critical
      // section. The grace resolver is responsible for the receipt now.
      expect(redisStorage.get("ibatexas:anonymize:pending:cust_01")).toBeTruthy();
      // Cooldown was NOT set (no cancel happened).
      expect(redisStorage.get("ibatexas:anonymize:cancel-cooldown:cust_01")).toBeUndefined();
      // anonymizeCustomer was NEVER called from this surface.
      expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
      // Lock is still held by the resolver — we did NOT acquire so we
      // MUST NOT release.
      expect(
        redisStorage.get("ibatexas:anonymize:active:cust_01"),
      ).toBe("resolving:uuid-from-grace-resolver");
    } finally {
      await app.close();
    }
  });

  it("[P0-3] acquires + releases the anonymize-active lock on a successful cancel", async () => {
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
      // Lock was released — key absent post-cancel.
      expect(
        redisStorage.get("ibatexas:anonymize:active:cust_01"),
      ).toBeUndefined();

      // The lock acquire-set call happened with NX:true and TTL 60s.
      const acquireCall = mockRedisSet.mock.calls.find(
        (c) => (c[0] as string).endsWith("anonymize:active:cust_01"),
      );
      expect(acquireCall).toBeTruthy();
      const opts = acquireCall![2] as { EX: number; NX: boolean };
      expect(opts.EX).toBe(60);
      expect(opts.NX).toBe(true);
    } finally {
      await app.close();
    }
  });
});
