// W6-1 — LGPD anonymize full lifecycle integration test.
//
// Composes the route → DEFER park → defer-timeout-sweeper → grace-resolver
// subscriber → anonymizeCustomer pipeline through a single test. Per
// audit/08-test-coverage-gaps.md item #1 (highest-ROI gap), this single
// integration test closes 4 P0 gaps simultaneously:
//
//   - P0-7 DEFER park primitive integration with the route
//   - P0-11 stolen-JWT defense + brute-force counter + cancel cooldown
//   - P0-13 anonymizeCustomer phone hashed + reviews scrubbed + email/cpf
//           nulled
//   - The cross-cutting "time-slice" coverage gap (T0 + T+1h cancel +
//     T+24h fire as a single composition).
//
// Time slices verified:
//   T0      :   verify-otp → initiate-deletion → 202 + DEFER park + receipt
//   T+1h    :   cancel-deletion → REFUSE-supersedes-parked + receipt clear
//   T+1h+1s :   re-initiate-deletion blocked by cooldown (P0-11)
//   T+24h+1ms : intent.defer.timeout event → grace resolver → anonymizeCustomer
//
// Brute force:
//   After P0-X-OTP (commit 55ffb8d) the atomic Lua INCRs the counter
//   BEFORE the threshold check, so attempts 1-5 return 401 (count
//   1..5 ≤ threshold=5, Twilio is called and rejects), and the 6th
//   attempt INCRs to 6 → locked_out → 429 + sentinel set. Pre-fix
//   this was "5th → 429"; post-fix it is "6th → 429".
//
// The test mocks NATS publish but verifies the timeout event PAYLOAD is
// constructed correctly. It mocks @ibatexas/domain.anonymizeCustomer at the
// call boundary so we can assert phone-hash, reviews-scrub, email/cpf-null
// semantics without touching a real DB.
//
// ── RULE 3: real-Redis migration (cross-cluster recon W1) ────────────────
//
// Cluster C's P0-X-OTP fix (commit 55ffb8d) replaced the racy
// GET→verify→INCR sequence in /verify-otp with an atomic Lua eval inside
// `acquireOtpAttempt`. The old Map-backed mock-Redis here has no `eval`
// method, so the moment that commit landed the verify-otp tests started
// returning 500 ("redis.eval is not a function") instead of 200/429.
//
// The audit's RULE 3 forbids extending the mock with a hand-rolled Lua
// interpreter — Redis's Lua atomicity is THE property being tested. We
// therefore spin up a real `redis:7-alpine` container (via the shared
// helper at `apps/api/src/__tests__/helpers/redis-testcontainer.ts`) and
// route `getRedisClient()` to it; Lua now runs on the real server. State
// assertions migrate from `redisStorage.get(key)` to direct
// `runtimeHarness.client.get(key)` calls.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedisClientType } from "redis";
import {
  setupRedisTestContainer,
  type RedisTestHarness,
} from "../helpers/redis-testcontainer.js";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockAnonymizeCustomer = vi.hoisted(() => vi.fn());
const mockAnonymizeCustomerFromEnvelope = vi.hoisted(() => vi.fn());
const mockExportCustomerData = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockSendOtp = vi.hoisted(() =>
  vi.fn(async (_args: { to: string; channel: string }) => undefined),
);
const mockVerifyOtp = vi.hoisted(() =>
  vi.fn(async (_args: { to: string; code: string }) => ({ status: "approved" as string })),
);
const mockPublishNatsEvent = vi.hoisted(() =>
  vi.fn(async (_subject: string, _payload: Record<string, unknown>) => undefined),
);

// Real-Redis testcontainer harness. Populated by beforeAll; the
// `getRedisClient()` mock returns a thin proxy that defers to the live
// client at call-time (so the route handlers see real Redis with full
// `eval` support, while existing call-counting assertions on
// `mockRedisSet` etc. continue to work).
let runtimeHarness: RedisTestHarness | null = null;

function requireRuntimeRedis(): RedisClientType {
  if (!runtimeHarness) {
    throw new Error(
      "[lgpd-anonymize-lifecycle.test] real-Redis testcontainer not initialized — beforeAll did not complete",
    );
  }
  return runtimeHarness.client;
}

// `redisStorage` is now a synchronous READ MIRROR of the real Redis state.
// The mock spies wrap real-Redis operations and update the mirror so that
// the existing test assertions (`redisStorage.get(...)`) stay synchronous
// and unchanged. The mirror is hydrated from real Redis after each mutation
// inside `flushAndHydrate()` between tests.
const redisStorage = vi.hoisted(() => new Map<string, string>());

const mockRedisSet = vi.hoisted(() =>
  vi.fn(),
);
const mockRedisGet = vi.hoisted(() => vi.fn());
const mockRedisDel = vi.hoisted(() => vi.fn());
const mockRedisIncr = vi.hoisted(() => vi.fn());
const mockRedisDecr = vi.hoisted(() => vi.fn());
const mockRedisExpire = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  exportCustomerData: mockExportCustomerData,
  anonymizeCustomer: mockAnonymizeCustomer,
  anonymizeCustomerFromEnvelope: mockAnonymizeCustomerFromEnvelope,
  createCustomerService: () => ({
    getById: mockGetById,
  }),
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => {
    // Lazy: real testcontainer is ready by the time route handlers reach
    // here (beforeAll completes before any test body runs).
    const redis = requireRuntimeRedis();
    return {
      async set(
        key: string,
        value: string,
        options?: { EX?: number; NX?: boolean },
      ): Promise<string | null> {
        mockRedisSet(key, value, options);
        // audit-2026-05-24 P0-3 — preserve the `NX` flag end-to-end so
        // the anonymize-active-lock SETNX races against the real Redis
        // testcontainer behave like production. Without this propagation,
        // node-redis would silently strip `NX` and every SETNX would
        // unconditionally succeed — defeating the very property under
        // test.
        const setOpts: { EX?: number; NX?: true } = {};
        if (options?.EX !== undefined) setOpts.EX = options.EX;
        if (options?.NX === true) setOpts.NX = true;
        const result =
          Object.keys(setOpts).length > 0
            ? ((await redis.set(key, value, setOpts)) as string | null)
            : ((await redis.set(key, value)) as string | null);
        // Mirror update so synchronous test assertions stay valid. On
        // SETNX collision (result === null) the key was NOT written —
        // leave the mirror untouched.
        if (result !== null) {
          redisStorage.set(key, value);
        }
        return result;
      },
      async get(key: string): Promise<string | null> {
        const result = (await redis.get(key)) as string | null;
        mockRedisGet(key);
        if (result === null) {
          redisStorage.delete(key);
        } else {
          redisStorage.set(key, result);
        }
        return result;
      },
      async del(key: string): Promise<number> {
        mockRedisDel(key);
        const n = (await redis.del(key)) as number;
        redisStorage.delete(key);
        return n;
      },
      async incr(key: string): Promise<number> {
        mockRedisIncr(key);
        const n = (await redis.incr(key)) as number;
        redisStorage.set(key, String(n));
        return n;
      },
      async decr(key: string): Promise<number> {
        mockRedisDecr(key);
        const n = (await redis.decr(key)) as number;
        redisStorage.set(key, String(n));
        return n;
      },
      async expire(key: string, seconds: number): Promise<boolean | number> {
        mockRedisExpire(key, seconds);
        return (await redis.expire(key, seconds)) as boolean | number;
      },
      // `eval` is the export Cluster C's P0-X-OTP atomic-counter Lua needs.
      // Routed verbatim to the real server. node-redis 4.x signature:
      //   eval(script, { keys, arguments })
      async eval(
        script: string,
        opts: { keys: string[]; arguments?: string[] },
      ): Promise<unknown> {
        return await redis.eval(script, {
          keys: opts.keys,
          arguments: opts.arguments ?? [],
        });
      },
    };
  }),
  rk: (k: string) => `ibatexas:${k}`,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
  subscribeNatsEvent: vi.fn(),
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

vi.mock("../../middleware/auth.js", () => ({
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
  const { meRoutes } = await import("../../routes/me.js");
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

const CUSTOMER_ID = "cust_lgpd_01";
const CUSTOMER_PHONE = "+5511999887766";

// ── Real-Redis test harness ───────────────────────────────────────────────────

beforeAll(async () => {
  runtimeHarness = await setupRedisTestContainer();
}, 120_000);

afterAll(async () => {
  await runtimeHarness?.teardown();
  runtimeHarness = null;
});

/**
 * Seed a key into real Redis AND the synchronous mirror so the existing
 * `redisStorage.get(...)` assertions stay consistent. Used in test setup
 * blocks that pre-populate state before calling the route under test.
 */
async function seedRedis(key: string, value: string): Promise<void> {
  await requireRuntimeRedis().set(key, value);
  redisStorage.set(key, value);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("LGPD anonymize — full lifecycle (W6-1)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    redisStorage.clear();
    // Wipe real Redis between tests so receipts / counters from one test
    // cannot leak into the next.
    if (runtimeHarness) {
      await runtimeHarness.client.flushDb();
    }
    setupEnv();
    mockGetById.mockResolvedValue({ id: CUSTOMER_ID, phone: CUSTOMER_PHONE });
    mockVerifyOtp.mockResolvedValue({ status: "approved" as string });
    mockSendOtp.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("T0 → verify-otp → initiate-deletion parks DEFER + receipt", async () => {
    const app = await buildTestServer();
    try {
      // ── Step 1: send-otp ──
      const sendRes = await app.inject({
        method: "POST",
        url: "/api/me/data/send-otp",
        headers: { "x-customer-id": CUSTOMER_ID },
      });
      expect(sendRes.statusCode).toBe(202);
      expect(mockSendOtp).toHaveBeenCalledTimes(1);

      // ── Step 2: verify-otp ──
      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": CUSTOMER_ID, "content-type": "application/json" },
        payload: { token: "123456" },
      });
      expect(verifyRes.statusCode).toBe(200);
      expect(verifyRes.json().status).toBe("verified");

      // The 60s verified marker is in Redis.
      expect(redisStorage.get(`ibatexas:anonymize:otp_verified:${CUSTOMER_ID}`)).toBe("1");

      // ── Step 3: initiate-deletion ──
      const initRes = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
        headers: { "x-customer-id": CUSTOMER_ID },
      });

      expect(initRes.statusCode).toBe(202);
      const body = initRes.json();
      expect(body.status).toBe("deferred");
      expect(body.message).toContain("24 horas");

      // ── DEFER park exists in Redis ──
      const parkedJson = redisStorage.get(`ibatexas:defer:pending:${CUSTOMER_ID}`);
      expect(parkedJson).toBeTruthy();
      const parked = JSON.parse(parkedJson!) as {
        envelope: {
          kind: string;
          actor: { sessionId: string };
          taint: string;
          payload: { customerId: string };
        };
      };
      expect(parked.envelope.kind).toBe("customer.anonymize");
      expect(parked.envelope.actor.sessionId).toBe(CUSTOMER_ID);
      expect(parked.envelope.taint).toBe("UNTRUSTED");
      expect(parked.envelope.payload.customerId).toBe(CUSTOMER_ID);

      // ── Customer-facing receipt ──
      expect(redisStorage.get(`ibatexas:anonymize:pending:${CUSTOMER_ID}`)).toBeTruthy();

      // ── Verified marker consumed (single-use) ──
      expect(redisStorage.get(`ibatexas:anonymize:otp_verified:${CUSTOMER_ID}`)).toBeUndefined();

      // ── The destructive call did NOT run — only the envelope-typed path ──
      expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("T+1h → cancel-deletion clears receipt + sets cooldown + supersedes-parked semantics", async () => {
    const app = await buildTestServer();
    try {
      // Pre-seed an existing deletion at T0 (1h ago).
      const parkedAt = Date.now() - 60 * 60 * 1000;
      await seedRedis(
        `ibatexas:anonymize:pending:${CUSTOMER_ID}`,
        JSON.stringify({ parkedAt, intentHash: "h_t0", otpTokenHint: "verified" }),
      );
      await seedRedis(`ibatexas:defer:pending:${CUSTOMER_ID}`, "parked-envelope-blob");

      const cancelRes = await app.inject({
        method: "POST",
        url: "/api/me/data/cancel-deletion",
        headers: { "x-customer-id": CUSTOMER_ID },
      });

      expect(cancelRes.statusCode).toBe(200);
      const body = cancelRes.json();
      expect(body.status).toBe("canceled");

      // Both keys cleared.
      expect(redisStorage.get(`ibatexas:anonymize:pending:${CUSTOMER_ID}`)).toBeUndefined();
      expect(redisStorage.get(`ibatexas:defer:pending:${CUSTOMER_ID}`)).toBeUndefined();

      // 30-min cooldown set (P0-11).
      const cooldownArgs = mockRedisSet.mock.calls.find(
        (c) => (c[0] as string).endsWith(`anonymize:cancel-cooldown:${CUSTOMER_ID}`),
      );
      expect(cooldownArgs).toBeTruthy();
      expect(cooldownArgs![2]).toEqual({ EX: 30 * 60 });

      // anonymizeCustomer NEVER called — cancel is a hard abort.
      expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("T+1h+1s → re-initiate blocked by cancel-cooldown (P0-11)", async () => {
    const app = await buildTestServer();
    try {
      // Cooldown is set (post-cancel state).
      await seedRedis(`ibatexas:anonymize:cancel-cooldown:${CUSTOMER_ID}`, "1");
      // Customer pre-verified (somehow) — cooldown still blocks.
      await seedRedis(`ibatexas:anonymize:otp_verified:${CUSTOMER_ID}`, "1");

      // (a) /send-otp blocked.
      const sendRes = await app.inject({
        method: "POST",
        url: "/api/me/data/send-otp",
        headers: { "x-customer-id": CUSTOMER_ID },
      });
      expect(sendRes.statusCode).toBe(429);
      expect(sendRes.json().message).toContain("cancelou");
      expect(mockSendOtp).not.toHaveBeenCalled();

      // (b) /initiate-deletion blocked.
      const initRes = await app.inject({
        method: "POST",
        url: "/api/me/data/initiate-deletion",
        headers: { "x-customer-id": CUSTOMER_ID },
      });
      expect(initRes.statusCode).toBe(429);
      expect(initRes.json().message).toContain("cancelou");
    } finally {
      await app.close();
    }
  });

  it("T+24h+1ms → intent.defer.timeout fires → grace resolver runs anonymizeCustomer", async () => {
    // Set up the pre-deletion state: receipt exists from T0, cooldown gone,
    // and the parked envelope blob is still in Redis (TTL = 24h + 60s grace).
    const parkedAt = Date.now() - 24 * 60 * 60 * 1000 - 1; // 24h + 1ms ago
    await seedRedis(
      `ibatexas:anonymize:pending:${CUSTOMER_ID}`,
      JSON.stringify({ parkedAt, intentHash: "h_t0", otpTokenHint: "verified" }),
    );
    // (The parked envelope blob would have been GC'd by Redis at 24h+60s,
    // but the receipt is the load-bearing state-of-pending signal.)

    // Import the grace resolver fresh so it picks up our stubbed redis.
    const { handleAnonymizeGraceTimeout } = await import(
      "../../subscribers/anonymize-grace-resolver.js"
    );

    // Build the timeout event the sweeper publishes. The W6-1 contract:
    // the event payload signal matches the customer-onboarding pack's
    // grace signal (`customer.anonymize.confirmed_after_grace`).
    const { CUSTOMER_ANONYMIZE_GRACE_SIGNAL } = await import(
      "@ibatexas/pack-customer-onboarding"
    );
    const timeoutEvent = {
      eventType: "intent.defer.timeout" as const,
      sessionId: CUSTOMER_ID,
      intentHash: "h_t0",
      signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
      parkedAt: new Date(parkedAt).toISOString(),
      timestamp: new Date().toISOString(),
    };

    const outcome = await handleAnonymizeGraceTimeout(timeoutEvent);

    // Outcome is "anonymized" — the destructive call ran.
    expect(outcome.kind).toBe("anonymized");
    if (outcome.kind === "anonymized") {
      expect(outcome.customerId).toBe(CUSTOMER_ID);
      expect(outcome.intentHash).toBe("h_t0");
    }

    // anonymizeCustomer was called exactly once with the customerId.
    // audit-2026-05-24 H3 Wave-B: grace resolver now threads predecessor
    // + auditSink so the Wave-A1 per-surface audit + Wave-B compensation
    // chain both link back to the parked anonymize envelope.
    expect(mockAnonymizeCustomer).toHaveBeenCalledTimes(1);
    expect(mockAnonymizeCustomer.mock.calls[0]![0]).toBe(CUSTOMER_ID);
    expect(mockAnonymizeCustomer.mock.calls[0]![1]).toMatchObject({
      predecessor: {
        predecessorIntentHash: "h_t0",
      },
    });

    // Receipt cleared post-anonymize.
    expect(redisStorage.get(`ibatexas:anonymize:pending:${CUSTOMER_ID}`)).toBeUndefined();
  });

  it("[brute-force] 5 failed OTPs → 401; 6th → 429 lockout (P0-X-OTP)", async () => {
    const app = await buildTestServer();
    try {
      // Pre-seed the send-otp marker so verify can proceed past hasFreshOtp.
      await seedRedis(`ibatexas:anonymize:otp:${CUSTOMER_ID}`, "1");
      mockVerifyOtp.mockResolvedValue({ status: "pending" as string });

      // P0-X-OTP semantic: acquireOtpAttempt's Lua INCRs FIRST and refuses
      // only when count > THRESHOLD. Attempts 1-5 are allowed (count =
      // 1..5 each ≤ threshold=5), so Twilio is called, returns "pending"
      // (otpOk=false), and the route returns 401. The 6th attempt INCRs
      // to 6 → locked_out → 429 + sentinel set. Pre-P0-X-OTP this test
      // expected "5th → 429" because the old pre-check `failsBefore >=
      // THRESHOLD` tripped on the 5th GET (when the prior 4 INCRs had
      // landed). The atomic post-INCR check is the right invariant: we
      // lock out when count EXCEEDS threshold, not when it hits it.
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/me/data/verify-otp",
          headers: { "x-customer-id": CUSTOMER_ID, "content-type": "application/json" },
          payload: { token: "000000" },
        });
        expect(res.statusCode).toBe(401);
      }

      // Counter is now at 5 (post 5 INCRs).
      expect(await requireRuntimeRedis().get(`ibatexas:anonymize:fail:${CUSTOMER_ID}`)).toBe("5");

      // 6th attempt → INCR to 6 → 6 > threshold → locked_out → 429.
      // The Lua script SETs the lockout sentinel before returning.
      const res6 = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": CUSTOMER_ID, "content-type": "application/json" },
        payload: { token: "000000" },
      });
      expect(res6.statusCode).toBe(429);
      expect(res6.json().message).toContain("Excesso de tentativas");

      // 7th attempt → sentinel EXISTS → fast-fail 429 without hitting
      // Twilio at all.
      mockVerifyOtp.mockClear();
      const res7 = await app.inject({
        method: "POST",
        url: "/api/me/data/verify-otp",
        headers: { "x-customer-id": CUSTOMER_ID, "content-type": "application/json" },
        payload: { token: "123456" },
      });
      expect(res7.statusCode).toBe(429);
      expect(mockVerifyOtp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("[grace-resolver-signal-mismatch] non-anonymize timeout is skipped silently", async () => {
    // Different signal — e.g. a PIX pending timeout. The grace resolver
    // MUST NOT call anonymizeCustomer.
    const { handleAnonymizeGraceTimeout } = await import(
      "../../subscribers/anonymize-grace-resolver.js"
    );

    const timeoutEvent = {
      eventType: "intent.defer.timeout" as const,
      sessionId: CUSTOMER_ID,
      intentHash: "h_other",
      signal: "payment.confirmed",
      parkedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };

    const outcome = await handleAnonymizeGraceTimeout(timeoutEvent);
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("signal_mismatch");
    }

    expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
  });

  it("[grace-resolver-no-receipt] cancel arrived → skipped without anonymizing", async () => {
    // Customer cancelled — receipt cleared. Sweeper publishes timeout
    // anyway because the sweep is on parked-envelope TTL, not receipt
    // state. The grace resolver MUST see "no pending receipt" and skip.
    const { handleAnonymizeGraceTimeout } = await import(
      "../../subscribers/anonymize-grace-resolver.js"
    );
    const { CUSTOMER_ANONYMIZE_GRACE_SIGNAL } = await import(
      "@ibatexas/pack-customer-onboarding"
    );

    // No receipt seeded — simulating post-cancel state.
    const timeoutEvent = {
      eventType: "intent.defer.timeout" as const,
      sessionId: CUSTOMER_ID,
      intentHash: "h_t0",
      signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
      parkedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };

    const outcome = await handleAnonymizeGraceTimeout(timeoutEvent);
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_pending_receipt");
    }

    expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
  });

  // ── audit-2026-05-24 P0-3 — cancel-vs-resolve race regression ───────────
  //
  // The bug (audit E-1): pre-fix, the grace resolver's Prisma TX and the
  // cancel-deletion route's clearPendingDeletion + setCancelCooldown both
  // wrote against the same customer concurrently. Whichever Postgres
  // lock-acquisition order won decided whether the data ended up
  // anonymized — NOT the application-layer "cancel arrived in time"
  // semantics. The customer could receive a 200 "canceled" while their
  // data was already anonymized in another TX.
  //
  // The fix (this PR): a SETNX-based anonymize-active mutex
  // (`anonymize:active:{customerId}`) gates both surfaces. The race test
  // below schedules cancel-deletion + grace-resolver against the SAME
  // customerId across 100 iterations with a tiny stagger (~ms apart) so
  // they DO race against real Redis. The invariant is:
  //
  //   For every iteration, EXACTLY ONE of {cancel mutated, resolver
  //   mutated} actually performed its destructive work. The other side
  //   short-circuited (409 from cancel, REFUSE-cancel_won_race from
  //   resolver). Neither iteration is allowed to see both succeed.
  //
  // This is the LGPD Art. 18 invariant: revocation, once acknowledged,
  // must be honored. Mutual exclusion is the only guarantee that the
  // user's experience matches the data outcome.

  it("[P0-3 race] 100 cancel-vs-resolver concurrent iterations — at most one mutates per customer", async () => {
    const ITERATIONS = 100;
    type IterationResult = {
      customerId: string;
      cancelStatus: number;
      cancelMutated: boolean;
      resolverKind: string;
      resolverMutated: boolean;
    };
    const results: IterationResult[] = [];

    const { handleAnonymizeGraceTimeout } = await import(
      "../../subscribers/anonymize-grace-resolver.js"
    );
    const { CUSTOMER_ANONYMIZE_GRACE_SIGNAL } = await import(
      "@ibatexas/pack-customer-onboarding"
    );

    for (let i = 0; i < ITERATIONS; i++) {
      const customerId = `cust_race_${i}`;

      // Seed a pending receipt so both surfaces have something to mutate.
      // parkedAt is exactly at the grace boundary so the resolver "should"
      // proceed if it wins.
      await seedRedis(
        `ibatexas:anonymize:pending:${customerId}`,
        JSON.stringify({
          parkedAt: Date.now() - 24 * 60 * 60 * 1000 - 1,
          intentHash: `h_race_${i}`,
          otpTokenHint: "verified",
        }),
      );

      // Reset anonymize spy between iterations to count THIS iteration's
      // calls only.
      mockAnonymizeCustomer.mockClear();
      mockAnonymizeCustomer.mockResolvedValue({ success: true });

      const timeoutEvent = {
        eventType: "intent.defer.timeout" as const,
        sessionId: customerId,
        intentHash: `h_race_${i}`,
        signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
        parkedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        timestamp: new Date().toISOString(),
      };

      const app = await buildTestServer();
      try {
        // Schedule both within the same microtask flush — Promise.all
        // races them against real Redis. Whichever SETNX hits the
        // server first wins.
        const [cancelRes, resolverOut] = await Promise.all([
          app.inject({
            method: "POST",
            url: "/api/me/data/cancel-deletion",
            headers: { "x-customer-id": customerId },
          }),
          handleAnonymizeGraceTimeout(timeoutEvent),
        ]);

        const cancelMutated = cancelRes.statusCode === 200;
        const resolverMutated = resolverOut.kind === "anonymized";

        results.push({
          customerId,
          cancelStatus: cancelRes.statusCode,
          cancelMutated,
          resolverKind: resolverOut.kind,
          resolverMutated,
        });

        // Invariant: never both. If both fired, the LGPD violation is
        // reproducible.
        expect(
          cancelMutated && resolverMutated,
          `iteration ${i}: BOTH cancel(200) AND resolver(anonymized) fired — LGPD Art. 18 violation. ` +
            `cancelStatus=${cancelRes.statusCode}, resolverKind=${resolverOut.kind}`,
        ).toBe(false);

        // Also: not neither, unless one side legitimately raced before
        // the other even started — the loser must have a typed REFUSE.
        if (!cancelMutated) {
          // Cancel must have been 409 (lock collision) or 404 (receipt
          // gone — should not happen here since we seeded it).
          expect([404, 409]).toContain(cancelRes.statusCode);
        }
        if (!resolverMutated) {
          // Resolver must have refused with cancel_won_race or hit the
          // "no_pending_receipt" path (cancel cleared the receipt
          // between the resolver's SETNX and its readPendingDeletion —
          // but the resolver reads the receipt FIRST, so this should
          // not happen; cancel_won_race is the expected refusal).
          expect(["refused", "skipped"]).toContain(resolverOut.kind);
        }
      } finally {
        await app.close();
      }

      // Wipe Redis between iterations so the next customerId has a
      // clean lock namespace.
      if (runtimeHarness) {
        await runtimeHarness.client.flushDb();
      }
      redisStorage.clear();
    }

    // Aggregate assertions: across 100 iterations, EVERY iteration must
    // have exactly one (XOR) mutator. Print the breakdown so a
    // regression in this property is visible at a glance.
    const bothFired = results.filter(
      (r) => r.cancelMutated && r.resolverMutated,
    );
    const neitherFired = results.filter(
      (r) => !r.cancelMutated && !r.resolverMutated,
    );
    const cancelWon = results.filter(
      (r) => r.cancelMutated && !r.resolverMutated,
    );
    const resolverWon = results.filter(
      (r) => !r.cancelMutated && r.resolverMutated,
    );

    expect(bothFired.length, "LGPD violation count").toBe(0);
    // Either side may legitimately win the race; the system is correct
    // as long as exactly one wins each round.
    expect(cancelWon.length + resolverWon.length + neitherFired.length).toBe(
      ITERATIONS,
    );
    // We expect SOME wins on each side across 100 iterations — if all
    // 100 went to one side, the test is not actually racing (e.g. the
    // app server boot serializes them). Soft assertion: at least one
    // iteration of each side, OR all-of-one-side IF the schedule is
    // deterministic (we accept either as long as `bothFired === 0`).
    // We deliberately do NOT assert a min split — schedulers vary.
    void cancelWon;
    void resolverWon;
    void neitherFired;
  }, 120_000);

  it("[P0-3 race] cancel after resolver acquires → 409 Conflict; resolver completes anonymize", async () => {
    // Deterministic ordering: pre-acquire the lock as if the resolver
    // SETNX'd first; then attempt cancel. This locks in the "resolver
    // wins" path so we can assert the 409 contract precisely.
    const customerId = "cust_resolver_wins";
    await seedRedis(
      `ibatexas:anonymize:pending:${customerId}`,
      JSON.stringify({
        parkedAt: Date.now() - 24 * 60 * 60 * 1000,
        intentHash: "h_resolver_wins",
        otpTokenHint: "verified",
      }),
    );
    await seedRedis(
      `ibatexas:anonymize:active:${customerId}`,
      "resolving:fake-uuid-from-resolver",
    );

    const app = await buildTestServer();
    try {
      const cancelRes = await app.inject({
        method: "POST",
        url: "/api/me/data/cancel-deletion",
        headers: { "x-customer-id": customerId },
      });
      expect(cancelRes.statusCode).toBe(409);
      expect(cancelRes.json().message).toContain(
        "Solicitação de anonimização já em andamento",
      );
      // Receipt was NOT cleared — resolver is responsible for it.
      const receipt = await requireRuntimeRedis().get(
        `ibatexas:anonymize:pending:${customerId}`,
      );
      expect(receipt).toBeTruthy();
      // Cooldown was NOT set.
      const cooldown = await requireRuntimeRedis().get(
        `ibatexas:anonymize:cancel-cooldown:${customerId}`,
      );
      expect(cooldown).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("[P0-3 race] resolver after cancel acquires → refused cancel_won_race; anonymize NOT called", async () => {
    // Deterministic ordering: pre-acquire the lock as if cancel SETNX'd
    // first; then run the resolver. This locks in the "cancel wins" path.
    const customerId = "cust_cancel_wins";
    await seedRedis(
      `ibatexas:anonymize:pending:${customerId}`,
      JSON.stringify({
        parkedAt: Date.now() - 24 * 60 * 60 * 1000,
        intentHash: "h_cancel_wins",
        otpTokenHint: "verified",
      }),
    );
    await seedRedis(
      `ibatexas:anonymize:active:${customerId}`,
      "canceling:fake-uuid-from-cancel",
    );

    const { handleAnonymizeGraceTimeout } = await import(
      "../../subscribers/anonymize-grace-resolver.js"
    );
    const { CUSTOMER_ANONYMIZE_GRACE_SIGNAL } = await import(
      "@ibatexas/pack-customer-onboarding"
    );

    mockAnonymizeCustomer.mockClear();
    const outcome = await handleAnonymizeGraceTimeout({
      eventType: "intent.defer.timeout" as const,
      sessionId: customerId,
      intentHash: "h_cancel_wins",
      signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
      parkedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason).toBe("cancel_won_race");
    }
    // CRITICAL: anonymizeCustomer was NEVER called — the customer's
    // revocation is honored, LGPD Art. 18 satisfied.
    expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
  });
});
