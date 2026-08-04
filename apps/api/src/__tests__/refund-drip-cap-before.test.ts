// P1-I — Pre-fix race REPRODUCTION test.
//
// This test directly exercises the OLD code pattern (GET → check →
// delay → INCRBY) against real Redis. It is a regression-catcher for
// the audit 03 R4 race. If this test passes after the fix, the race
// has been killed.
//
// Real Redis comes from the SHARED testcontainer harness
// (`helpers/redis-testcontainer.ts`). This file used to gate on its own
// `REDIS_TEST_URL` env check, unset in CI — so the race demo skipped
// silently while the file reported green (measured on dev @ 2f5c4979:
// "refund-drip-cap-before.test.ts (2 tests | 1 skipped)"). Retired by M0 of
// the multi()/eval ruling (docs/architecture/redis-lua-testing-decision.md,
// Q1): one knob only, `IBX_SKIP_REAL_REDIS=1`, local-dev-only, policed by
// `scripts/check-real-redis-suites.mjs`.
//
// Scenario: N=5 concurrent reservations at 8000 centavos with cap
// 20000 centavos. Pre-fix: all 5 read currentTotal=0, all pass the
// cap check, all INCRBY → final = 40000 > cap (TOCTOU exploited).
// Post-fix: at most floor(cap/amount)=2 reservations succeed.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest"
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

/**
 * The OLD racy pattern as it existed pre-P1-I-TRUE: GET → check →
 * (delay simulating kernel + Prisma + NATS) → INCRBY. Used to PROVE
 * the race is exploitable against real Redis.
 */
async function racyReserveAndIncrement(
  redis: RedisClientType,
  key: string,
  amount: number,
  cap: number,
  ttl: number,
): Promise<{ kind: "allowed"; newTotal: number } | { kind: "refused"; current: number }> {
  const raw = await redis.get(key)
  const current = raw ? Number.parseInt(raw, 10) : 0
  const projected = current + amount
  if (projected > cap) {
    return { kind: "refused", current }
  }
  // Simulate the executeRefund latency (kernel + Prisma + NATS) — this
  // is the window the race exploits.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const newTotal = await redis.incrBy(key, amount)
  await redis.expire(key, ttl)
  return { kind: "allowed", newTotal }
}

describe.skipIf(!RUN_REAL_REDIS)(
  "P1-I refund cap pre-fix race demonstration (real Redis)",
  () => {
    const TEST_KEY = `test-w1c:before-race:refund:${Date.now()}`

    // 120s: a COLD `redis:7-alpine` pull can outlast the package-wide 30s
    // hookTimeout (apps/api/vitest.config.ts).
    beforeAll(async () => {
      await setupRedis()
    }, 120_000)

    beforeEach(async () => {
      const redis = await setupRedis()
      await redis.del(TEST_KEY)
    })

    it("DEMONSTRATES the OLD racy pattern exploits the cap (this should FAIL pre-fix logic)", async () => {
      const redis = await setupRedis()
      const N = 5
      const amount = 8000
      const cap = 20000
      const ttl = 25 * 60 * 60

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          racyReserveAndIncrement(redis, TEST_KEY, amount, cap, ttl),
        ),
      )

      const allowed = results.filter((r) => r.kind === "allowed")
      const finalTotal = Number.parseInt(
        (await redis.get(TEST_KEY)) ?? "0",
        10,
      )
      const expectedMax = Math.floor(cap / amount)

      // The racy pattern lets more than floor(cap/amount) succeed —
      // this is the bug. The assertion verifies the race is real
      // (allowed > expected) AND the final total exceeds the cap.
      //
      // If real-Redis timing happens to serialize fully (unlikely with
      // a 5ms delay window), this is documented honestly via the
      // overshoot count.
      const overshoot = allowed.length - expectedMax
      const totalOvershoot = finalTotal - cap

      // eslint-disable-next-line no-console
      console.log(
        `[P1-I pre-fix demo] allowed=${allowed.length} (expected max ${expectedMax}) finalTotal=${finalTotal} (cap ${cap}) overshoot=${overshoot}`,
      )

      // Assert the race was observed: at least one extra reservation
      // beyond the cap-defined limit succeeded. This is the documented
      // bug per audit 03 R4. If this assertion is true with the racy
      // pattern, removing the pattern (post-fix) must make it false.
      expect(
        overshoot >= 1 || totalOvershoot >= 1,
        `Expected the racy pattern to overshoot the cap. Got allowed=${allowed.length} (max ${expectedMax}) finalTotal=${finalTotal} (cap ${cap}).`,
      ).toBe(true)
    }, 15_000)
  },
)
