// M1 — THE CAE SHAPE CONTRACT. Compare-and-extend, every site. REAL REDIS.
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2). Model:
// park-nx-release-failure-mode.test.ts. Sibling: lua-shape-cad-contract.test.ts,
// whose header explains why these suites read production source text.
//
// THE SHAPE
//   if redis.call('GET', KEYS[1]) == ARGV[1] then
//     return redis.call('EXPIRE'|'PEXPIRE', KEYS[1], ARGV[2]) else return 0 end
//
// THE CONTRACT: only the holder may push the deadline out. Every site is a
// heartbeat — a long-running turn, a WhatsApp agent lock, a journey run — and
// each one runs on a TIMER, so it fires repeatedly against a key it may have
// stopped owning. An unguarded extend is worse than an unguarded delete: it does
// not free the new owner's lock, it keeps the OLD owner's deadline alive on it,
// so the new owner's lock outlives its own intended TTL and the next acquirer
// blocks on a lock nobody holds.
//
// ── The shape is NOT uniform, and that is the point of enumerating it ────────
//
// Two sites call EXPIRE (ARGV[2] in SECONDS); `packages/journeys` calls PEXPIRE
// (ARGV[2] in MILLISECONDS). The site table below records the unit per site,
// because a suite that assumed one unit would either be asserting the wrong band
// or quietly passing a 600x error. This is exactly what a per-shape suite is for
// — the divergence is invisible from any single site.
//
// ── TTL assertions are BANDED, never `> 0` ───────────────────────────────────
//
// A `toBeGreaterThan(0)` TTL assertion cannot tell a refused extend from a
// granted one: both leave a positive TTL. Every case below pins a two-sided
// band, and the load-bearing half of the REFUSED arm is the UPPER bound — the
// key must still be near its original short deadline, not the long one.
//
// Gated by RUN_REAL_REDIS; enrolled in the M0 roll call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { extractLuaAfter } from "./helpers/lua-script-sources.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

interface CaeSite {
  readonly label: string
  readonly file: string
  readonly anchor: string
  /** ARGV[2]'s unit: EXPIRE takes seconds, PEXPIRE takes milliseconds. */
  readonly unit: "s" | "ms"
}

/**
 * THE THREE PRODUCTION CAE SITES — hand-written, from the census inventory
 * ("The full production Lua inventory"). This count was correct.
 */
const CAE_SITES: readonly CaeSite[] = [
  {
    label: "streaming/execution-queue — web agent lock heartbeat",
    file: "apps/api/src/streaming/execution-queue.ts",
    anchor: "const EXTEND_LOCK_SCRIPT =",
    unit: "s",
  },
  {
    label: "whatsapp/session — agent lock heartbeat",
    file: "apps/api/src/whatsapp/session.ts",
    anchor: "const EXTEND_LOCK_SCRIPT =",
    unit: "s",
  },
  {
    label: "packages/journeys journey-lock — journey heartbeat (PEXPIRE, ms)",
    file: "packages/journeys/src/runner/journey-lock.ts",
    anchor: "const HEARTBEAT_SCRIPT =",
    unit: "ms",
  },
]

/** NAME PIN — hand-written, not derived. See the CAD suite's note (F-14). */
const CAE_SITE_ROLL_CALL: readonly string[] = [
  "streaming/execution-queue — web agent lock heartbeat",
  "whatsapp/session — agent lock heartbeat",
  "packages/journeys journey-lock — journey heartbeat (PEXPIRE, ms)",
]

const OUR_TOKEN = "11111111-1111-4111-8111-111111111111"
const FOREIGN_TOKEN = "99999999-9999-4999-8999-999999999999"

/** The short deadline a key is seeded with, in ms. */
const SHORT_MS = 5_000
/** The long deadline a granted extend must produce, in ms. */
const LONG_MS = 600_000

/** Same removal experiment as the CAD suite: delete the ownership conjunct. */
function stripOwnershipGuard(script: string): string {
  const guard = /redis\.call\((['"])GET\1,\s*KEYS\[1\]\)\s*==\s*ARGV\[1\]/i
  if (!guard.test(script)) {
    throw new Error(
      `stripOwnershipGuard found no CAE guard to remove in: ${JSON.stringify(script)}`,
    )
  }
  return script.replace(guard, "true")
}

describe.skipIf(!RUN_REAL_REDIS)("Lua shape contract — CAE (real Redis)", () => {
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

  /** ARGV[2] for a LONG_MS deadline, in the site's own unit. */
  const longArg = (unit: "s" | "ms"): string =>
    unit === "s" ? String(LONG_MS / 1000) : String(LONG_MS)

  const evalCae = async (
    script: string,
    key: string,
    token: string,
    ttlArg: string,
  ): Promise<number> =>
    (await harness.client.eval(script, {
      keys: [key],
      arguments: [token, ttlArg],
    })) as number

  // ── 0. The population is pinned by hand ───────────────────────────────────

  it("the CAE site table matches the hand-written roll call, site for site", () => {
    expect(CAE_SITES.map((s) => s.label)).toEqual(CAE_SITE_ROLL_CALL)
    expect(CAE_SITES).toHaveLength(3)
    // The unit split is the reason this table carries a `unit` column at all.
    expect(CAE_SITES.filter((s) => s.unit === "ms").map((s) => s.file)).toEqual([
      "packages/journeys/src/runner/journey-lock.ts",
    ])
  })

  // ── 1. The contract, at every site ────────────────────────────────────────

  it.each(CAE_SITES)("$label obeys the CAE contract", async ({ file, anchor, unit }) => {
    const script = extractLuaAfter(file, anchor)
    const key = "cae:contract:key"

    // (a) The holder extends: returns 1, and the deadline really moved out.
    await harness.client.set(key, OUR_TOKEN, { PX: SHORT_MS })
    expect(await evalCae(script, key, OUR_TOKEN, longArg(unit))).toBe(1)
    const extended = await harness.client.pTTL(key)
    expect(extended).toBeGreaterThan(LONG_MS - 5_000)
    expect(extended).toBeLessThanOrEqual(LONG_MS)

    // (b) THE PROPERTY: a non-holder does NOT extend. Returns 0, and the key is
    //     still on its ORIGINAL short deadline. The upper bound is what carries
    //     this — a granted extend would put it near LONG_MS.
    await harness.client.set(key, FOREIGN_TOKEN, { PX: SHORT_MS })
    expect(await evalCae(script, key, OUR_TOKEN, longArg(unit))).toBe(0)
    const refused = await harness.client.pTTL(key)
    expect(refused).toBeGreaterThan(SHORT_MS - 3_000)
    expect(refused).toBeLessThanOrEqual(SHORT_MS)
    expect(await harness.client.get(key)).toBe(FOREIGN_TOKEN)

    // (c) An absent key returns 0 and is NOT created — an extend never
    //     resurrects a lapsed lock.
    await harness.client.del(key)
    expect(await evalCae(script, key, OUR_TOKEN, longArg(unit))).toBe(0)
    expect(await harness.client.exists(key)).toBe(0)
  })

  // ── 2. ARGV[2] is interpreted in the site's own unit ─────────────────────

  it.each(CAE_SITES)("$label reads ARGV[2] in its declared unit", async ({
    file,
    anchor,
    unit,
  }) => {
    // The bug this catches: a site switched EXPIRE↔PEXPIRE, or a caller passes
    // seconds to a PEXPIRE site. Either way the deadline is off by 1000x, and
    // every `toBeGreaterThan(0)` TTL assertion in the repo stays green through
    // it. Here, asking for 60 SECONDS in the site's unit must land in a 60s band.
    const script = extractLuaAfter(file, anchor)
    const key = "cae:unit:key"
    const sixtySeconds = unit === "s" ? "60" : "60000"

    await harness.client.set(key, OUR_TOKEN, { PX: SHORT_MS })
    expect(await evalCae(script, key, OUR_TOKEN, sixtySeconds)).toBe(1)
    const ttl = await harness.client.pTTL(key)
    expect(ttl).toBeGreaterThan(55_000)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })

  // ── 3. Per-site CONJUNCT-REMOVAL CONTROL ─────────────────────────────────

  it.each(CAE_SITES)(
    "$label — with the ownership conjunct REMOVED, the foreign lock's deadline is pushed out",
    async ({ file, anchor, unit }) => {
      const script = extractLuaAfter(file, anchor)
      const mutated = stripOwnershipGuard(script)
      expect(mutated).not.toBe(script)

      const key = "cae:control:key"
      // Byte-identical end state to arm (b) above.
      await harness.client.set(key, FOREIGN_TOKEN, { PX: SHORT_MS })

      expect(await evalCae(mutated, key, OUR_TOKEN, longArg(unit))).toBe(1)
      const damaged = await harness.client.pTTL(key)
      expect(damaged).toBeGreaterThan(LONG_MS - 5_000)
      expect(damaged).toBeLessThanOrEqual(LONG_MS)
    },
  )

  // ── 4. The heartbeat scenario, end to end ────────────────────────────────

  it("a heartbeat that outlives its own lock never keeps the NEW owner's lock alive", async () => {
    // The live shape: our lock lapses, someone else acquires, and our
    // setInterval fires once more. Bounded iteration (Q3).
    const { file, anchor, unit } = CAE_SITES[0]!
    const script = extractLuaAfter(file, anchor)
    const key = "cae:heartbeat:key"

    for (let round = 0; round < 5; round += 1) {
      await harness.client.set(key, OUR_TOKEN, { PX: 40 })
      await new Promise((r) => setTimeout(r, 60))
      expect(await harness.client.exists(key)).toBe(0) // our lock really lapsed

      // The new owner takes it with a SHORT deadline of their own.
      await harness.client.set(key, FOREIGN_TOKEN, { PX: SHORT_MS })
      // Our stale heartbeat fires.
      expect(await evalCae(script, key, OUR_TOKEN, longArg(unit))).toBe(0)

      // Their deadline is untouched — they keep control of when it expires.
      const ttl = await harness.client.pTTL(key)
      expect(ttl).toBeGreaterThan(SHORT_MS - 3_000)
      expect(ttl).toBeLessThanOrEqual(SHORT_MS)
      await harness.client.del(key)
    }
  })

  // ── 5. Shape identity, modulo the EXPIRE/PEXPIRE split ───────────────────

  it("every CAE site is the same guard; only the EXPIRE verb differs", () => {
    const normalized = CAE_SITES.map(({ file, anchor }) =>
      extractLuaAfter(file, anchor)
        .replace(/\s+/g, " ")
        .replace(/"/g, "'")
        .toLowerCase()
        .trim(),
    )
    expect(normalized).toEqual([
      "if redis.call('get', keys[1]) == argv[1] then return redis.call('expire', keys[1], argv[2]) else return 0 end",
      "if redis.call('get', keys[1]) == argv[1] then return redis.call('expire', keys[1], argv[2]) else return 0 end",
      "if redis.call('get', keys[1]) == argv[1] then return redis.call('pexpire', keys[1], argv[2]) else return 0 end",
    ])
    // The guard is identical at all three; the verb is what varies.
    const guards = new Set(normalized.map((s) => s.slice(0, s.indexOf(" then"))))
    expect([...guards]).toEqual(["if redis.call('get', keys[1]) == argv[1]"])
  })
})
