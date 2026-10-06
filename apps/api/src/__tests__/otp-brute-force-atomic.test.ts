// P0-X-OTP — Atomic INCR + threshold check for OTP brute-force counter.
//
// Audit 03 R6 documented the race:
//   getOtpFailureCount → verifyAnonymizeOtp (Twilio ~300ms) →
//   incrementOtpFailureCount on fail.
// N concurrent attempts within the Twilio window all read the same
// starting count, all pass the threshold check, all proceed to verify.
// ~30 free attempts per ~300ms burst per the audit's measurement.
//
// Post-fix: acquireOtpAttempt atomically INCR + threshold + lockout
// sentinel in a single Lua eval. N concurrent attempts each see a
// distinct post-INCR count; the (THRESHOLD+1) onwards trip lockout.
//
// Uses real Redis via the SHARED testcontainer harness
// (`helpers/redis-testcontainer.ts`). This file used to gate on its own
// `REDIS_TEST_URL` env check, unset in CI — so all four cases skipped
// silently while the file reported green (measured on dev @ 2f5c4979:
// "otp-brute-force-atomic.test.ts (5 tests | 4 skipped)"). Retired by M0
// of the multi()/eval ruling (docs/architecture/redis-lua-testing-
// decision.md, Q1): one knob only, `IBX_SKIP_REAL_REDIS=1`, local-dev-only,
// policed by `scripts/check-real-redis-suites.mjs`.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest"
import type { RedisClientType } from "redis"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

let harness: RedisTestHarness | null = null
let testRedis: RedisClientType | null = null

async function setupRedis(): Promise<RedisClientType> {
  if (testRedis) return testRedis
  harness = await setupRedisTestContainer()
  testRedis = harness.client
  return testRedis
}

afterAll(async () => {
  if (harness) {
    await harness.teardown()
    harness = null
    testRedis = null
  }
})

// Mock @ibatexas/tools.getRedisClient → real test Redis; preserve other
// exports so transitively-imported modules don't break.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@ibatexas/tools")
  return {
    ...actual,
    getRedisClient: vi.fn(async () => testRedis as unknown),
    rk: (key: string) => `test-w1c-otp:${key}`,
  }
})

const {
  acquireOtpAttempt,
  resetOtpFailureCount,
  clearOtpLockout,
  ANONYMIZE_FAIL_THRESHOLD,
} = await import("../routes/me/anonymize-otp-gate.js")

describe.skipIf(!RUN_REAL_REDIS)(
  "P0-X-OTP atomic brute-force counter (real Redis, concurrency)",
  () => {
    const TEST_CUSTOMER = `cust_${Date.now()}`

    // 120s: a COLD `redis:7-alpine` pull can outlast the package-wide 30s
    // hookTimeout (apps/api/vitest.config.ts).
    beforeAll(async () => {
      await setupRedis()
    }, 120_000)

    beforeEach(async () => {
      const redis = await setupRedis()
      // Clear test-namespace keys.
      const pattern = `test-w1c-otp:anonymize:*`
      for await (const key of redis.scanIterator({ MATCH: pattern })) {
        if (Array.isArray(key)) {
          for (const k of key) await redis.del(k)
        } else {
          await redis.del(key as string)
        }
      }
    })

    it("10 concurrent attempts: counter increments atomically to 10; attempts beyond threshold return locked_out", async () => {
      const N = 10
      // ANONYMIZE_FAIL_THRESHOLD = 5. Attempts 1-5 should be allowed,
      // 6-10 should be locked_out.
      const results = await Promise.all(
        Array.from({ length: N }, () => acquireOtpAttempt(TEST_CUSTOMER)),
      )

      const allowed = results.filter((r) => r.kind === "allowed")
      const lockedOut = results.filter((r) => r.kind === "locked_out")

      // ── Atomicity check #1: counter accurately reflects all 10 INCRs.
      const redis = await setupRedis()
      const stored = await redis.get(
        `test-w1c-otp:anonymize:fail:${TEST_CUSTOMER}`,
      )
      expect(stored).not.toBeNull()
      // The Lua script does NOT increment after lockout-sentinel is set
      // (fast-fail). So the counter increments while count <= threshold
      // and on each over-threshold attempt UP TO the one that sets the
      // sentinel; after that the EXISTS check short-circuits without
      // INCR.
      //
      // Worst case (all 10 race in before any lockout sentinel lands):
      //   counter reaches 10.
      // Best case (sequential after the first 6 set the sentinel):
      //   counter stays at 6.
      // Either way, the counter MUST equal allowed.length + lockedOut
      // attempts that incremented before the sentinel was set.
      const storedCount = Number.parseInt(stored!, 10)
      expect(storedCount).toBeGreaterThanOrEqual(allowed.length)
      expect(storedCount).toBeLessThanOrEqual(N)

      // ── Atomicity check #2: each post-INCR count is unique.
      // The pre-fix race would have several attempts see the same
      // starting count. Post-fix every INCR returns a distinct count.
      // (Locked-out attempts triggered by the sentinel may report the
      // same count, which is fine.)
      const allowedCounts = allowed.map((r) => r.count).sort((a, b) => a - b)
      expect(new Set(allowedCounts).size).toBe(allowed.length)

      // ── Authorization check: at most THRESHOLD attempts succeed.
      expect(allowed.length).toBeLessThanOrEqual(ANONYMIZE_FAIL_THRESHOLD)
      expect(lockedOut.length).toBeGreaterThanOrEqual(N - ANONYMIZE_FAIL_THRESHOLD)
    }, 15_000)

    it("sequential attempts: first 5 allowed, 6th onwards locked_out", async () => {
      const results: Array<Awaited<ReturnType<typeof acquireOtpAttempt>>> = []
      for (let i = 0; i < 7; i++) {
        results.push(await acquireOtpAttempt(TEST_CUSTOMER))
      }
      // ANONYMIZE_FAIL_THRESHOLD = 5: attempts 1-5 allowed, 6+ locked.
      expect(results[0]?.kind).toBe("allowed")
      expect(results[1]?.kind).toBe("allowed")
      expect(results[2]?.kind).toBe("allowed")
      expect(results[3]?.kind).toBe("allowed")
      expect(results[4]?.kind).toBe("allowed")
      // 6th attempt: count=6 > threshold=5 → locked, sentinel set.
      expect(results[5]?.kind).toBe("locked_out")
      // 7th attempt: sentinel exists → fast-fail without INCR.
      expect(results[6]?.kind).toBe("locked_out")
      const r6 = results[5] as { kind: "locked_out"; fromSentinel: boolean }
      const r7 = results[6] as { kind: "locked_out"; fromSentinel: boolean }
      expect(r6.fromSentinel).toBe(false)
      expect(r7.fromSentinel).toBe(true)
    })

    it("successful reset clears counter; subsequent attempt is allowed", async () => {
      // Trip the counter once.
      const r1 = await acquireOtpAttempt(TEST_CUSTOMER)
      expect(r1.kind).toBe("allowed")
      // Reset (simulating successful Twilio verify).
      await resetOtpFailureCount(TEST_CUSTOMER)
      // Next attempt counts from 1 again.
      const r2 = await acquireOtpAttempt(TEST_CUSTOMER)
      expect(r2.kind).toBe("allowed")
      expect((r2 as { kind: "allowed"; count: number }).count).toBe(1)
    })

    it("lockout survives reset of fail counter — sentinel TTL must run", async () => {
      // Burn through threshold.
      for (let i = 0; i < ANONYMIZE_FAIL_THRESHOLD + 1; i++) {
        await acquireOtpAttempt(TEST_CUSTOMER)
      }
      // Operator force-resets the fail counter (e.g., support ticket).
      await resetOtpFailureCount(TEST_CUSTOMER)
      // Next attempt still locked out via the sentinel.
      const r = await acquireOtpAttempt(TEST_CUSTOMER)
      expect(r.kind).toBe("locked_out")
      expect((r as { fromSentinel: boolean }).fromSentinel).toBe(true)
      // Only clearOtpLockout (ops-only) releases the window.
      await clearOtpLockout(TEST_CUSTOMER)
      const r2 = await acquireOtpAttempt(TEST_CUSTOMER)
      expect(r2.kind).toBe("allowed")
    })
  },
)
