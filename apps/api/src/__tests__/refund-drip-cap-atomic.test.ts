// P1-I-TRUE — refund drip-cap atomic check-and-increment.
//
// Audit 03 R4 documented the pre-fix race:
//   GET total → check projected → execute refund → INCRBY post-execute
// Five concurrent refunds at cap-1 all read currentTotal=0, all passed
// the check, all executed, all INCRBYed — cap bypassed by ~5×.
//
// This test uses a REAL Redis (not a Map stub) and fires N=5 concurrent
// calls to tryReserveDailyRefund. Assertion: AT MOST k reservations
// succeed where k×amount ≤ cap.
//
// Real Redis comes from the SHARED testcontainer harness
// (`helpers/redis-testcontainer.ts`). This file used to gate on its own
// `REDIS_TEST_URL` env check, unset in CI — so all three cases skipped
// silently while the file reported green (measured on dev @ 2f5c4979:
// "refund-drip-cap-atomic.test.ts (4 tests | 3 skipped)"). Retired by M0 of
// the multi()/eval ruling (docs/architecture/redis-lua-testing-decision.md,
// Q1): one knob only, `IBX_SKIP_REAL_REDIS=1`, local-dev-only, policed by
// `scripts/check-real-redis-suites.mjs`.
//
// Scenario:
//   N=5, amount=R$80,00 (8000 centavos), cap=R$200,00 (20000 centavos)
//   floor(cap/amount) = 2 → at most 2 reservations may succeed.
//   Pre-fix: all 5 succeed. Post-fix: exactly 2 succeed.

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

// Mock @ibatexas/tools.getRedisClient to return our real test Redis.
// importOriginal so we keep tool exports (SearchProductsTool etc) that
// other transitively-imported modules need.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@ibatexas/tools")
  return {
    ...actual,
    getRedisClient: vi.fn(async () => testRedis as unknown),
    rk: (key: string) => `test-w1c:${key}`,
  }
})

// Now import the helper after the mock is in place.
const { tryReserveDailyRefund } = await import("../routes/admin/payments.js")

describe.skipIf(!RUN_REAL_REDIS)(
  "P1-I-TRUE refund drip cap (real Redis, concurrency)",
  () => {
    const TEST_STAFF = `staff_${Date.now()}`

    // 120s: a COLD `redis:7-alpine` pull can outlast the package-wide 30s
    // hookTimeout (apps/api/vitest.config.ts).
    beforeAll(async () => {
      await setupRedis()
    }, 120_000)

    beforeEach(async () => {
      const redis = await setupRedis()
      // Clear any stale keys from the test namespace.
      const pattern = "test-w1c:refund:daily-total:*"
      for await (const key of redis.scanIterator({ MATCH: pattern })) {
        if (Array.isArray(key)) {
          for (const k of key) await redis.del(k)
        } else {
          await redis.del(key as string)
        }
      }
    })

    it("concurrent reservations beyond cap are atomically refused", async () => {
      // Scenario: 5 concurrent refunds at 8000 centavos (R$80,00) each
      // against cap 20000 centavos (R$200,00).
      // floor(20000 / 8000) = 2 → at most 2 should be allowed.
      const N = 5
      const amount = 8000
      const cap = 20000

      // Fire all N reservations concurrently. Promise.all over actual
      // async functions hitting the real Redis — NOT Promise.resolve()
      // synthetic compositions.
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          tryReserveDailyRefund(TEST_STAFF, amount, cap),
        ),
      )

      const allowed = results.filter((r) => r.kind === "allowed")
      const refused = results.filter((r) => r.kind === "cap_exceeded")

      // INVARIANT: total allowed × amount ≤ cap.
      const totalAllowed = allowed.length * amount
      expect(
        totalAllowed,
        `Drip cap bypass: ${allowed.length} reservations × ${amount} = ${totalAllowed} > cap ${cap}`,
      ).toBeLessThanOrEqual(cap)

      // Stronger: exactly floor(cap/amount) = 2 should be allowed.
      expect(allowed).toHaveLength(Math.floor(cap / amount))
      expect(refused).toHaveLength(N - Math.floor(cap / amount))

      // Verify the actual stored counter matches the sum of allowed.
      const redis = await setupRedis()
      const today = new Date()
      const yyyy = today.getUTCFullYear()
      const mm = String(today.getUTCMonth() + 1).padStart(2, "0")
      const dd = String(today.getUTCDate()).padStart(2, "0")
      const key = `test-w1c:refund:daily-total:${TEST_STAFF}:${yyyy}-${mm}-${dd}`
      const stored = await redis.get(key)
      expect(stored).not.toBeNull()
      expect(Number.parseInt(stored!, 10)).toBe(allowed.length * amount)
    }, 15_000)

    it("sequential reservations within cap all succeed", async () => {
      const amount = 5000
      const cap = 20000

      const r1 = await tryReserveDailyRefund(TEST_STAFF, amount, cap)
      const r2 = await tryReserveDailyRefund(TEST_STAFF, amount, cap)
      const r3 = await tryReserveDailyRefund(TEST_STAFF, amount, cap)
      const r4 = await tryReserveDailyRefund(TEST_STAFF, amount, cap)
      // 4 × 5000 = 20000 = cap — last one fills exactly.
      const r5 = await tryReserveDailyRefund(TEST_STAFF, amount, cap)
      // 5th would push to 25000 > cap → refused.

      expect(r1.kind).toBe("allowed")
      expect(r2.kind).toBe("allowed")
      expect(r3.kind).toBe("allowed")
      expect(r4.kind).toBe("allowed")
      expect(r5.kind).toBe("cap_exceeded")
    })

    it("exact-at-cap reservation succeeds; one-over fails", async () => {
      const cap = 10000
      // First reservation at cap: should succeed.
      const r1 = await tryReserveDailyRefund(TEST_STAFF, cap, cap)
      expect(r1.kind).toBe("allowed")
      // Any further refund (even 1 centavo) must fail.
      const r2 = await tryReserveDailyRefund(TEST_STAFF, 1, cap)
      expect(r2.kind).toBe("cap_exceeded")
    })
  },
)
