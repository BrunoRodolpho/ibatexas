// M1 — THE RATE-LIMIT SHAPE CONTRACT. INCR + window, both sites. REAL REDIS.
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2). Sibling:
// lua-shape-cad-contract.test.ts, whose header explains the source-text seam.
//
// THE TWO SITES ARE NOT THE SAME SCRIPT — and that is why they are here.
//
//   apps/api/src/plugins/rate-limit.ts        INCR, PEXPIRE (ms) on the first
//                                             hit or while continuing to exceed,
//                                             else PTTL. Returns {current, window}.
//   packages/tools/src/redis/atomic-rate-limit.ts
//                                             INCR, EXPIRE (s) when count == 1.
//                                             Returns count.
//
// Different verbs, different units, different return arities. What they share is
// the conjunct both were written for, stated in `atomic-rate-limit.ts`'s own
// header: *"if the process crashes between INCR and EXPIRE, the key would
// persist forever, permanently rate-limiting that bucket."*
//
// THE CONTRACT
//   1. A counter is NEVER immortal. After any hit, the key carries a bounded TTL.
//   2. Counting is exact under concurrency: N concurrent hits leave the counter
//      at exactly N, and the N callers see N DISTINCT values 1..N — nobody is
//      handed a slot someone else was also handed.
//   3. The window really expires, and the counter resets with it.
//
// Property 1 is an availability property with an access-control edge: an
// immortal counter does not fail open, it fails STUCK — that bucket is rate
// limited forever, and for the api plugin the bucket is a client IP.
//
// ── Coverage before this file ────────────────────────────────────────────────
//
// Zero real-Redis bytes at either site. `apps/api/src/__tests__/rate-limit-plugin.test.ts`
// mocks `@fastify/rate-limit` wholesale and asserts registration options, so the
// Lua never executes; `packages/tools/src/redis/__tests__/atomic-rate-limit.test.ts`
// stubs `eval` and asserts `expect(script).toContain("INCR")` — a substring check
// on a string that is never run. Both would stay green with either script's
// EXPIRE deleted, which is exactly the immortal-counter defect.
//
// Gated by RUN_REAL_REDIS; enrolled in the M0 roll call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { RedisClientType } from "redis"
import { extractLuaAfter } from "./helpers/lua-script-sources.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

interface RateLimitSite {
  readonly label: string
  readonly file: string
  readonly anchor: string
  /**
   * Issue ONE hit against `key` with a `windowMs` window, in this site's own
   * calling convention, and return the counter value the caller sees.
   */
  readonly bump: (
    client: RedisClientType,
    script: string,
    key: string,
    windowMs: number,
  ) => Promise<number>
}

/**
 * THE TWO PRODUCTION RATE-LIMIT SITES — hand-written, from the census inventory
 * ("The full production Lua inventory").
 */
const RATE_LIMIT_SITES: readonly RateLimitSite[] = [
  {
    label: "plugins/rate-limit — the @fastify/rate-limit store shim (PEXPIRE, ms)",
    file: "apps/api/src/plugins/rate-limit.ts",
    anchor: "const RATE_LIMIT_LUA =",
    bump: async (client, script, key, windowMs) => {
      const res = (await client.eval(script, {
        keys: [key],
        // timeWindow(ms), max, continueExceeding
        arguments: [String(windowMs), "1000000", "false"],
      })) as [number, number]
      return res[0]
    },
  },
  {
    label: "packages/tools atomic-rate-limit — atomicIncr (EXPIRE, s)",
    file: "packages/tools/src/redis/atomic-rate-limit.ts",
    anchor: "const ATOMIC_INCR_SCRIPT =",
    bump: async (client, script, key, windowMs) => {
      const res = await client.eval(script, {
        keys: [key],
        arguments: [String(Math.round(windowMs / 1000))],
      })
      return Number(res)
    },
  },
]

/** NAME PIN — hand-written, not derived. See the CAD suite's note (F-14). */
const RATE_LIMIT_SITE_ROLL_CALL: readonly string[] = [
  "plugins/rate-limit — the @fastify/rate-limit store shim (PEXPIRE, ms)",
  "packages/tools atomic-rate-limit — atomicIncr (EXPIRE, s)",
]

const WINDOW_MS = 60_000

/**
 * Delete the TTL-setting call and nothing else — the conjunct-removal
 * experiment for this shape. Throws when there is nothing to remove, so the
 * controls can never degenerate into re-runs of the unmutated script.
 */
function stripTtlSet(script: string): string {
  const ttlSet = /redis\.call\((['"])P?EXPIRE\1,[^)]*\)/i
  if (!ttlSet.test(script)) {
    throw new Error(`stripTtlSet found no EXPIRE/PEXPIRE to remove in: ${JSON.stringify(script)}`)
  }
  return script.replace(ttlSet, "")
}

describe.skipIf(!RUN_REAL_REDIS)("Lua shape contract — rate limit (real Redis)", () => {
  let harness: RedisTestHarness

  beforeAll(async () => {
    harness = await setupRedisTestContainer()
  }, 120_000)

  afterAll(async () => {
    await harness?.teardown()
  })

  beforeEach(async () => {
    await harness.client.flushAll()
  })

  // ── 0. The population is pinned by hand ───────────────────────────────────

  it("the rate-limit site table matches the hand-written roll call, site for site", () => {
    expect(RATE_LIMIT_SITES.map((s) => s.label)).toEqual(RATE_LIMIT_SITE_ROLL_CALL)
    expect(RATE_LIMIT_SITES).toHaveLength(2)
  })

  // ── 1. The counter is never immortal ─────────────────────────────────────

  it.each(RATE_LIMIT_SITES)(
    "$label — the first hit sets a BOUNDED window, so the counter can never become immortal",
    async ({ file, anchor, bump }) => {
      const script = extractLuaAfter(file, anchor)
      const key = "ratelimit:immortality:key"

      expect(await bump(harness.client, script, key, WINDOW_MS)).toBe(1)

      const ttl = await harness.client.pTTL(key)
      // -1 is node-redis for "key exists, NO expiry" — the immortal counter.
      // A `toBeGreaterThan(0)` here would also pass on a 1ms window, so the
      // band is two-sided.
      expect(ttl).not.toBe(-1)
      expect(ttl).toBeGreaterThan(WINDOW_MS - 5_000)
      expect(ttl).toBeLessThanOrEqual(WINDOW_MS)

      // And it stays bounded as the counter climbs — Q3 bounded iteration, the
      // invariant asserted per iteration.
      for (let hit = 2; hit <= 6; hit += 1) {
        expect(await bump(harness.client, script, key, WINDOW_MS)).toBe(hit)
        const t = await harness.client.pTTL(key)
        expect(t).not.toBe(-1)
        expect(t).toBeGreaterThan(WINDOW_MS - 5_000)
        expect(t).toBeLessThanOrEqual(WINDOW_MS)
      }
    },
  )

  // ── 2. Per-site CONJUNCT-REMOVAL CONTROL ─────────────────────────────────

  it.each(RATE_LIMIT_SITES)(
    "$label — with the TTL-set REMOVED, the counter is immortal and the bucket is stuck forever",
    async ({ file, anchor, bump }) => {
      const script = extractLuaAfter(file, anchor)
      const mutated = stripTtlSet(script)
      expect(mutated).not.toBe(script)

      const key = "ratelimit:control:key"
      expect(await bump(harness.client, mutated, key, WINDOW_MS)).toBe(1)

      // THE DEFECT both scripts exist to prevent, made real: the key has no
      // expiry, so this bucket is rate-limited until someone deletes it by hand.
      expect(await harness.client.pTTL(key)).toBe(-1)
      expect(await harness.client.exists(key)).toBe(1)
    },
  )

  it.each(RATE_LIMIT_SITES)(
    "$label — the non-atomic INCR-then-EXPIRE leaves the same immortal key when it is interrupted",
    async ({ file, anchor, bump }) => {
      // The other half of the same conjunct. The script's atomicity is what
      // makes "INCR happened but EXPIRE did not" unreachable; from the client,
      // it is one crashed process away. `atomic-rate-limit.ts`'s header names
      // exactly this sequence.
      const key = "ratelimit:nonatomic:key"
      await harness.client.incr(key)
      // …process dies here, before the EXPIRE.
      expect(await harness.client.pTTL(key)).toBe(-1)

      // The real script, in the same position, cannot leave that state.
      const script = extractLuaAfter(file, anchor)
      await harness.client.del(key)
      await bump(harness.client, script, key, WINDOW_MS)
      expect(await harness.client.pTTL(key)).not.toBe(-1)
    },
  )

  // ── 3. Counting is exact under concurrency ───────────────────────────────

  it.each(RATE_LIMIT_SITES)(
    "$label — 25 concurrent hits leave exactly 25 and hand out 25 DISTINCT slots",
    async ({ file, anchor, bump }) => {
      const script = extractLuaAfter(file, anchor)
      const key = "ratelimit:atomicity:key"

      for (let round = 0; round < 3; round += 1) {
        await harness.client.del(key)
        const seen = await Promise.all(
          Array.from({ length: 25 }, () => bump(harness.client, script, key, WINDOW_MS)),
        )
        // No two callers were handed the same slot — the property a
        // read-then-write limiter cannot promise, and the one that decides
        // whether the 25th request is allowed or refused.
        expect([...seen].sort((a, b) => a - b)).toEqual(
          Array.from({ length: 25 }, (_, i) => i + 1),
        )
        expect(await harness.client.get(key)).toBe("25")
      }
    },
  )

  // ── 4. The window really expires ─────────────────────────────────────────

  it("the api plugin's window expires and the counter resets with it", async () => {
    // Only the plugin site takes a millisecond window, so only it can be driven
    // through a real expiry inside a test. The tools site's EXPIRE takes whole
    // seconds; its window band is pinned in case 1 instead.
    const site = RATE_LIMIT_SITES[0]!
    const script = extractLuaAfter(site.file, site.anchor)
    const key = "ratelimit:window:key"

    expect(await site.bump(harness.client, script, key, 150)).toBe(1)
    expect(await site.bump(harness.client, script, key, 150)).toBe(2)

    await new Promise((r) => setTimeout(r, 220))

    expect(await harness.client.exists(key)).toBe(0)
    expect(await site.bump(harness.client, script, key, 150)).toBe(1)
  })

  it("the api plugin reports the REMAINING window on later hits, not a fresh one", async () => {
    // `timeWindow = redis.call('PTTL', KEYS[1])` — the else-branch. If it
    // returned the requested window instead, every hit would look like the
    // start of a new window to the caller and Retry-After would be wrong.
    const site = RATE_LIMIT_SITES[0]!
    const script = extractLuaAfter(site.file, site.anchor)
    const key = "ratelimit:remaining:key"

    const first = (await harness.client.eval(script, {
      keys: [key],
      arguments: [String(WINDOW_MS), "1000000", "false"],
    })) as [number, number]
    expect(first[0]).toBe(1)
    expect(first[1]).toBe(WINDOW_MS)

    await new Promise((r) => setTimeout(r, 120))

    const second = (await harness.client.eval(script, {
      keys: [key],
      arguments: [String(WINDOW_MS), "1000000", "false"],
    })) as [number, number]
    expect(second[0]).toBe(2)
    // Strictly less than the first — time really passed and PTTL was read.
    expect(second[1]).toBeLessThan(WINDOW_MS)
    expect(second[1]).toBeGreaterThan(WINDOW_MS - 5_000)
  })

  it("the api plugin's continueExceeding=true pushes the window OUT past the cap", async () => {
    // The `continueExceeding` conjunct: over the cap, the window is re-armed on
    // every hit, so an attacker who keeps hammering keeps extending their own
    // lockout instead of waiting one window out.
    const site = RATE_LIMIT_SITES[0]!
    const script = extractLuaAfter(site.file, site.anchor)
    const key = "ratelimit:continue:key"
    const hit = async (windowMs: number, max: string, cont: string): Promise<[number, number]> =>
      (await harness.client.eval(script, {
        keys: [key],
        arguments: [String(windowMs), max, cont],
      })) as [number, number]

    // Two hits against a cap of 1: the second is over.
    expect((await hit(1_000, "1", "true"))[0]).toBe(1)
    await new Promise((r) => setTimeout(r, 150))
    const overWindow = await harness.client.pTTL(key)
    expect(overWindow).toBeLessThan(900) // the window has been draining

    expect((await hit(60_000, "1", "true"))[0]).toBe(2)
    // Re-armed to the NEW window rather than left to drain.
    const rearmed = await harness.client.pTTL(key)
    expect(rearmed).toBeGreaterThan(55_000)
    expect(rearmed).toBeLessThanOrEqual(60_000)
  })
})
