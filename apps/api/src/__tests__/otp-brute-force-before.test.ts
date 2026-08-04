// P0-X-OTP — Pre-fix race REPRODUCTION test.
//
// This test directly exercises the OLD code pattern (GET → simulated
// Twilio delay → INCR) against real Redis. It demonstrates the bug:
// N concurrent attempts in the Twilio window all read the same
// starting count, all pass the threshold check, all "proceed" to
// verify.
//
// Uses real Redis via the SHARED testcontainer harness
// (`helpers/redis-testcontainer.ts`). This file used to gate on its own
// `REDIS_TEST_URL` env check, unset in CI — so the race demo skipped
// silently while the file reported green (measured on dev @ 2f5c4979:
// "otp-brute-force-before.test.ts (2 tests | 1 skipped)"). Retired by M0 of
// the multi()/eval ruling (docs/architecture/redis-lua-testing-decision.md,
// Q1): one knob only, `IBX_SKIP_REAL_REDIS=1`, local-dev-only, policed by
// `scripts/check-real-redis-suites.mjs`.

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

const THRESHOLD = 5
const FAIL_TTL_SECONDS = 30 * 60

/**
 * The OLD pre-fix sequence: GET → check threshold → (Twilio delay) →
 * INCR on fail. Returns whether the attempt "proceeded past the gate"
 * (i.e., would have hit Twilio).
 */
async function racyAttempt(
  redis: RedisClientType,
  failKey: string,
): Promise<{ proceededPastGate: boolean; observedCount: number }> {
  // Step 1: GET
  const raw = await redis.get(failKey)
  const observedCount = raw ? Number.parseInt(raw, 10) : 0
  // Step 2: threshold check
  if (observedCount >= THRESHOLD) {
    return { proceededPastGate: false, observedCount }
  }
  // Step 3: simulated Twilio round-trip (~300ms — the race window).
  await new Promise((resolve) => setTimeout(resolve, 10))
  // Step 4: INCR on failure (the pre-fix code only INCRed on fail).
  const newCount = await redis.incr(failKey)
  if (newCount === 1) {
    await redis.expire(failKey, FAIL_TTL_SECONDS)
  }
  return { proceededPastGate: true, observedCount }
}

describe.skipIf(!RUN_REAL_REDIS)(
  "P0-X-OTP pre-fix race demonstration (real Redis)",
  () => {
    const TEST_KEY = `test-w1c-otp-before:fail:${Date.now()}`

    // 120s: a COLD `redis:7-alpine` pull can outlast the package-wide 30s
    // hookTimeout (apps/api/vitest.config.ts).
    beforeAll(async () => {
      await setupRedis()
    }, 120_000)

    beforeEach(async () => {
      const redis = await setupRedis()
      await redis.del(TEST_KEY)
    })

    it("DEMONSTRATES the OLD racy pattern allows N attempts past the threshold gate", async () => {
      const redis = await setupRedis()
      // Fire N=10 concurrent attempts. THRESHOLD=5; in a serialized
      // world only 5 should pass. With the race, the GET-then-check
      // sees count=0 for all, so all 10 proceed past the gate.
      const N = 10

      const results = await Promise.all(
        Array.from({ length: N }, () => racyAttempt(redis, TEST_KEY)),
      )

      const proceeded = results.filter((r) => r.proceededPastGate).length
      const finalCount = Number.parseInt(
        (await redis.get(TEST_KEY)) ?? "0",
        10,
      )

      // eslint-disable-next-line no-console
      console.log(
        `[P0-X-OTP pre-fix demo] N=${N} threshold=${THRESHOLD} proceeded=${proceeded} finalCount=${finalCount}`,
      )

      // The race lets MORE than threshold attempts past the gate.
      // (If proceeded ≤ threshold, the race didn't materialize — the
      // delay window was tighter than expected. Re-run with longer
      // delay.)
      expect(
        proceeded,
        `Expected racy pattern to let more than ${THRESHOLD} attempts past the gate.`,
      ).toBeGreaterThan(THRESHOLD)
    }, 15_000)
  },
)
