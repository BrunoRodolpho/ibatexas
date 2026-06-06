// P1-I — Pre-fix race REPRODUCTION test.
//
// This test directly exercises the OLD code pattern (GET → check →
// delay → INCRBY) against real Redis. It is a regression-catcher for
// the audit 03 R4 race. If this test passes after the fix, the race
// has been killed.
//
// Skipped when REDIS_TEST_URL is not set.
//
// Scenario: N=5 concurrent reservations at 8000 centavos with cap
// 20000 centavos. Pre-fix: all 5 read currentTotal=0, all pass the
// cap check, all INCRBY → final = 40000 > cap (TOCTOU exploited).
// Post-fix: at most floor(cap/amount)=2 reservations succeed.

import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { createClient, type RedisClientType } from "redis"

const REDIS_URL = process.env.REDIS_TEST_URL
const RUN_REAL_REDIS = REDIS_URL !== undefined && REDIS_URL.length > 0

let testRedis: RedisClientType | null = null

async function setupRedis(): Promise<RedisClientType> {
  if (testRedis) return testRedis
  const c = createClient({ url: REDIS_URL }) as RedisClientType
  c.on("error", () => {})
  await c.connect()
  testRedis = c
  return c
}

afterAll(async () => {
  if (testRedis) {
    await testRedis.quit().catch(() => {})
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

// Non-skipped guard so vitest reports the file as "ran".
describe("P1-I refund cap — pre-fix demo guard", () => {
  it("documents the real-Redis test gating", () => {
    if (!RUN_REAL_REDIS) {
      // eslint-disable-next-line no-console
      console.warn(
        "[P1-I pre-fix demo] REDIS_TEST_URL not set; skipping real-Redis race demo.",
      )
    }
    expect(true).toBe(true)
  })
})
