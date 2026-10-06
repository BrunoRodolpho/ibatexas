// M1 — THE TOKEN-BUCKET SHAPE CONTRACT. HMGET/HSET/PEXPIRE refill. REAL REDIS.
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2). Sibling:
// lua-shape-cad-contract.test.ts, whose header explains the source-text seam.
//
// SITE: apps/api/src/whatsapp/client.ts:285 `TOKEN_BUCKET_SCRIPT` — one site,
// so this file is the shape. It is the outbound WhatsApp send limiter, i.e. the
// thing standing between a reply storm and Meta's rate limits.
//
// THE CONTRACT
//   1. A fresh bucket starts FULL: `burst` sends are admitted, the next is not.
//   2. Tokens refill at `rate`/second and SATURATE at `burst` — an idle hour
//      does not buy an hour's worth of sends.
//   3. `waitMs` is honest: after waiting exactly that long, a send is admitted.
//   4. Concurrent sends against a bucket holding N tokens admit exactly N.
//   5. The key always carries a bounded TTL, so idle buckets expire.
//
// This is the only shape in the inventory whose script does real arithmetic
// (`math.min`, `math.ceil`, a division by `rate`), so its contract is a refill
// CURVE rather than a branch — property 2 is the one a boundary-only suite
// would miss, and it is the one that decides whether the limiter is a limiter
// or a speed bump.
//
// ── Clock discipline ─────────────────────────────────────────────────────────
//
// `now` is ARGV[3] and the script's only source of time; it reads back the `ts`
// it wrote on the previous call. So elapsed time is driven by passing it, and
// there is not one sleep in the file. Property 3 in particular is expressed as
// "advance `now` by exactly the waitMs the script returned", which a real sleep
// could only approximate.
//
// ── Coverage before this file ────────────────────────────────────────────────
//
// Zero real-Redis bytes. `apps/api/src/__tests__/whatsapp-client.test.ts:22`
// stubs `eval` and asserts only the key it was called with, so every number
// this script computes — the refill, the saturation, the wait — is uncovered.
//
// Gated by RUN_REAL_REDIS; enrolled in the M0 roll call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { extractLuaAfter } from "./helpers/lua-script-sources.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

const SITE_FILE = "apps/api/src/whatsapp/client.ts"
const SITE_ANCHOR = "const TOKEN_BUCKET_SCRIPT ="

/** Production shape of the knobs: a few sends per second, a small burst. */
const RATE = 2 // tokens per second
const BURST = 5
const T0 = 1_700_000_000_000

/** The script's own TTL formula: ceil(burst / rate * 1000) + 1000. */
const EXPECTED_TTL_MS = Math.ceil((BURST / RATE) * 1000) + 1000

/** Delete the PEXPIRE — the conjunct-removal experiment for this shape. */
function stripTtlSet(script: string): string {
  const ttl = /redis\.call\('PEXPIRE', key,[^\n]*\)/
  if (!ttl.test(script)) {
    throw new Error(`stripTtlSet found no PEXPIRE to remove in: ${JSON.stringify(script)}`)
  }
  return script.replace(ttl, "")
}

describe.skipIf(!RUN_REAL_REDIS)("Lua shape contract — token bucket (real Redis)", () => {
  let harness: RedisTestHarness
  let script: string

  beforeAll(async () => {
    harness = await setupRedisTestContainer()
    script = extractLuaAfter(SITE_FILE, SITE_ANCHOR)
  }, 120_000)

  afterAll(async () => {
    await harness?.teardown()
  })

  beforeEach(async () => {
    await harness.client.flushAll()
  })

  const KEY = "wa:tokenbucket:contract"

  interface Verdict {
    readonly allowed: number
    readonly waitMs: number
  }

  const take = async (now: number, src: string = script): Promise<Verdict> => {
    const [allowed, waitMs] = (await harness.client.eval(src, {
      keys: [KEY],
      arguments: [String(RATE), String(BURST), String(now)],
    })) as [number, number]
    return { allowed, waitMs }
  }

  // ── 1. A fresh bucket is FULL, and empties at exactly `burst` ────────────

  it("a fresh bucket admits exactly `burst` sends and refuses the next", async () => {
    for (let i = 0; i < BURST; i += 1) {
      const v = await take(T0)
      expect(v.allowed).toBe(1)
      expect(v.waitMs).toBe(0)
    }
    // The (burst+1)th send at the SAME instant has no token to take.
    const over = await take(T0)
    expect(over.allowed).toBe(0)
    expect(over.waitMs).toBeGreaterThan(0)
  })

  // ── 2. waitMs is honest ─────────────────────────────────────────────────

  it("waiting exactly the returned waitMs admits the next send — and one ms less does not", async () => {
    for (let i = 0; i < BURST; i += 1) await take(T0)
    const refused = await take(T0)
    expect(refused.allowed).toBe(0)

    // One millisecond short of the quoted wait: still refused. This is the half
    // that makes the assertion a boundary rather than a direction.
    const early = await take(T0 + refused.waitMs - 1)
    expect(early.allowed).toBe(0)

    // At the quoted wait, admitted. `waitMs` is ceil()'d, so this is exact.
    const onTime = await take(T0 + refused.waitMs)
    expect(onTime.allowed).toBe(1)
  })

  it("one token accrues in exactly 1000/rate ms", async () => {
    for (let i = 0; i < BURST; i += 1) await take(T0)
    const msPerToken = 1000 / RATE

    // Drained. Advance one token's worth: exactly one send gets through.
    const first = await take(T0 + msPerToken)
    expect(first.allowed).toBe(1)
    const second = await take(T0 + msPerToken)
    expect(second.allowed).toBe(0)
  })

  // ── 3. Refill SATURATES at burst — the curve, not the branch ────────────

  it("an idle hour does not buy an hour of sends — the bucket saturates at `burst`", async () => {
    for (let i = 0; i < BURST; i += 1) await take(T0)
    expect((await take(T0)).allowed).toBe(0)

    // Idle for an hour. At `rate` tokens/sec that would be 7200 tokens if the
    // refill were unbounded; `math.min(burst, …)` is the only thing capping it.
    const later = T0 + 3_600_000
    let admitted = 0
    for (let i = 0; i < BURST + 10; i += 1) {
      if ((await take(later)).allowed === 1) admitted += 1
    }
    expect(admitted).toBe(BURST)
  })

  it("a partial idle gap refills proportionally, not fully", async () => {
    for (let i = 0; i < BURST; i += 1) await take(T0)
    // Exactly 2 tokens' worth of time — not enough to refill the bucket.
    const later = T0 + 2 * (1000 / RATE)
    let admitted = 0
    for (let i = 0; i < BURST + 5; i += 1) {
      if ((await take(later)).allowed === 1) admitted += 1
    }
    expect(admitted).toBe(2)
  })

  // ── 4. Atomicity — concurrent sends cannot over-admit ───────────────────

  it("concurrent sends against a full bucket admit exactly `burst`", async () => {
    // Q3: bounded iteration, invariant asserted per iteration.
    for (let round = 0; round < 5; round += 1) {
      await harness.client.del(KEY)
      const verdicts = await Promise.all(
        Array.from({ length: 20 }, () => take(T0)),
      )
      expect(verdicts.filter((v) => v.allowed === 1)).toHaveLength(BURST)
      expect(verdicts.filter((v) => v.allowed === 0)).toHaveLength(20 - BURST)
    }
  })

  it("control — a non-atomic read-modify-write over-admits past the burst", async () => {
    // The same 20 concurrent sends with the refill computed in JS between an
    // HMGET and an HSET. If the case above were passing for some other reason,
    // this would also report exactly `burst`, and fail.
    const takeNonAtomically = async (now: number): Promise<number> => {
      const data = await harness.client.hmGet(KEY, ["tokens", "ts"])
      const tokens = data[0] === null || data[0] === undefined ? BURST : Number(data[0])
      const ts = data[1] === null || data[1] === undefined ? now : Number(data[1])
      const refilled = Math.min(BURST, tokens + (Math.max(0, now - ts) / 1000) * RATE)
      const allowed = refilled >= 1 ? 1 : 0
      await harness.client.hSet(KEY, {
        tokens: String(allowed === 1 ? refilled - 1 : refilled),
        ts: String(now),
      })
      return allowed
    }

    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => takeNonAtomically(T0)),
    )
    expect(verdicts.filter((v) => v === 1).length).toBeGreaterThan(BURST)
  })

  // ── 5. The bucket key always expires ────────────────────────────────────

  it("every send re-arms a BOUNDED TTL matching the script's own formula", async () => {
    await take(T0)
    const ttl = await harness.client.pTTL(KEY)
    // -1 is "exists, no expiry" — an immortal bucket for that phone number.
    expect(ttl).not.toBe(-1)
    // The formula is ceil(burst/rate*1000)+1000; pin the band around it rather
    // than asserting `> 0`, which a 1 ms TTL would also satisfy.
    expect(ttl).toBeGreaterThan(EXPECTED_TTL_MS - 1_000)
    expect(ttl).toBeLessThanOrEqual(EXPECTED_TTL_MS)
  })

  it("with the PEXPIRE REMOVED, the bucket key is immortal", async () => {
    const mutated = stripTtlSet(script)
    expect(mutated).not.toBe(script)

    const v = await take(T0, mutated)
    expect(v.allowed).toBe(1)
    expect(await harness.client.exists(KEY)).toBe(1)
    expect(await harness.client.pTTL(KEY)).toBe(-1)
  })

  // ── 6. State is written where the next call reads it ────────────────────

  it("the bucket persists tokens and ts, and the next call reads them back", async () => {
    await take(T0)
    const after = await harness.client.hGetAll(KEY)
    expect(Number(after["tokens"])).toBeCloseTo(BURST - 1, 5)
    expect(after["ts"]).toBe(String(T0))

    // Sanity that the read-back path is live: a hand-planted empty bucket is
    // honoured rather than re-defaulted to full.
    await harness.client.hSet(KEY, { tokens: "0", ts: String(T0) })
    expect((await take(T0)).allowed).toBe(0)
  })
})
