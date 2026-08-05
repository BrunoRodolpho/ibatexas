// M1 — THE CONSUME SHAPE CONTRACT. Single-use receipts, every site. REAL REDIS.
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2). Model:
// park-nx-release-failure-mode.test.ts. Sibling: lua-shape-cad-contract.test.ts,
// whose header explains why these suites read production source text.
//
// THE SHAPE
//   local value = redis.call('GET', KEYS[1])
//   if value then redis.call('DEL', KEYS[1]) return value else return nil end
//
// THE CONTRACT: the receipt is redeemed AT MOST ONCE. Exactly one caller gets
// the value; every later or concurrent caller gets nil.
//
// ── Why this is the shape M1 does second, right after CAD ────────────────────
//
// All four sites are confirmation stores on money or authority paths — an
// escalation approval, an order cancellation, an admin action, a checkout. The
// receipt IS the authorization. "Two racing approvals must not both win" is the
// census's phrasing for item 3, and the double that stood in for this script at
// four of those sites (census class (i), items 3-6) emulated it as an
// unconditional GET+DEL in a JS Map — which cannot fail the race it exists to
// win, because there is no race inside one JS process.
//
// ── The conjunct being pinned, and its control ───────────────────────────────
//
// CAD's conjunct is ownership and you remove it by deleting `== ARGV[1]`.
// CONSUME has no ownership test — its conjunct is ATOMICITY itself: that the GET
// and the DEL are one indivisible server-side step. So the removal experiment is
// not a text edit. It is running the same two commands from the client, which is
// precisely what the retired doubles did and what a `multi()`-less client would
// do:
//
//     const v = await client.get(key); if (v) await client.del(key)
//
// `consumeNonAtomically` below is that version, and the per-site control
// requires it to hand the SAME receipt to MORE THAN ONE caller. That is the
// defect the Lua prevents, demonstrated rather than asserted — and it is why
// these cases would go red if the production script were flattened into
// client-side commands.
//
// Gated by RUN_REAL_REDIS; enrolled in the M0 roll call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { extractLuaAfter } from "./helpers/lua-script-sources.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

interface LuaSite {
  readonly label: string
  readonly file: string
  readonly anchor: string
}

/**
 * THE FOUR PRODUCTION CONSUME SITES — hand-written, from the census inventory
 * ("The full production Lua inventory"). Unlike CAD, this count was correct.
 */
const CONSUME_SITES: readonly LuaSite[] = [
  {
    label: "escalation/escalation-park-store — parked escalation approval",
    file: "apps/api/src/escalation/escalation-park-store.ts",
    anchor: "const CONSUME_PARK_SCRIPT =",
  },
  {
    label: "routes/order-cancel-confirmation-store — order cancel receipt",
    file: "apps/api/src/routes/order-cancel-confirmation-store.ts",
    anchor: "const CONSUME_RECEIPT_SCRIPT =",
  },
  {
    label: "routes/admin/admin-confirmation-store — admin action receipt",
    file: "apps/api/src/routes/admin/admin-confirmation-store.ts",
    anchor: "const CONSUME_RECEIPT_SCRIPT =",
  },
  {
    label: "routes/checkout-confirmation-store — checkout receipt",
    file: "apps/api/src/routes/checkout-confirmation-store.ts",
    anchor: "const CONSUME_RECEIPT_SCRIPT =",
  },
]

/** NAME PIN — hand-written, not derived. See the CAD suite's note (F-14). */
const CONSUME_SITE_ROLL_CALL: readonly string[] = [
  "escalation/escalation-park-store — parked escalation approval",
  "routes/order-cancel-confirmation-store — order cancel receipt",
  "routes/admin/admin-confirmation-store — admin action receipt",
  "routes/checkout-confirmation-store — checkout receipt",
]

/** A realistic receipt: what these stores actually park is a JSON snapshot. */
const RECEIPT = JSON.stringify({
  intentHash: "sha256:2f0a9c",
  amountCentavos: 8900,
  approvedBy: "staff_42",
})

describe.skipIf(!RUN_REAL_REDIS)("Lua shape contract — CONSUME (real Redis)", () => {
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

  const consume = async (script: string, key: string): Promise<string | null> =>
    (await harness.client.eval(script, { keys: [key] })) as string | null

  /**
   * The SAME operation without the server-side indivisibility: GET, then DEL,
   * from the client. This is the retired doubles' emulation and the shape's
   * conjunct-removal experiment.
   */
  const consumeNonAtomically = async (key: string): Promise<string | null> => {
    const value = await harness.client.get(key)
    if (value !== null) await harness.client.del(key)
    return value
  }

  // ── 0. The population is pinned by hand ───────────────────────────────────

  it("the CONSUME site table matches the hand-written roll call, site for site", () => {
    expect(CONSUME_SITES.map((s) => s.label)).toEqual(CONSUME_SITE_ROLL_CALL)
    expect(CONSUME_SITES).toHaveLength(4)
  })

  // ── 1. The contract, at every site ────────────────────────────────────────

  it.each(CONSUME_SITES)("$label obeys the CONSUME contract", async ({ file, anchor }) => {
    const script = extractLuaAfter(file, anchor)
    const key = "consume:contract:key"
    const neighbour = "consume:contract:neighbour"

    await harness.client.set(key, RECEIPT)
    await harness.client.set(neighbour, "untouched")

    // (a) The redeemer gets the EXACT bytes back, and the key is gone with it.
    expect(await consume(script, key)).toBe(RECEIPT)
    expect(await harness.client.exists(key)).toBe(0)

    // (b) THE PROPERTY: single use. The second redemption gets nothing.
    expect(await consume(script, key)).toBeNull()

    // (c) An absent key returns nil and is not created.
    expect(await consume(script, "consume:contract:never-written")).toBeNull()
    expect(await harness.client.exists("consume:contract:never-written")).toBe(0)

    // (d) Blast radius is exactly KEYS[1].
    expect(await harness.client.get(neighbour)).toBe("untouched")
  })

  // ── 2. Atomicity — exactly one winner, at every site ─────────────────────

  it.each(CONSUME_SITES)(
    "$label — concurrent redemptions admit EXACTLY ONE winner",
    async ({ file, anchor }) => {
      const script = extractLuaAfter(file, anchor)
      const key = "consume:atomicity:key"

      // Q3: bounded iteration, invariant asserted per iteration.
      for (let round = 0; round < 5; round += 1) {
        await harness.client.set(key, RECEIPT)
        const results = await Promise.all(
          Array.from({ length: 20 }, () => consume(script, key)),
        )
        const winners = results.filter((r) => r !== null)
        expect(winners).toEqual([RECEIPT])
        expect(results.filter((r) => r === null)).toHaveLength(19)
        expect(await harness.client.exists(key)).toBe(0)
      }
    },
  )

  // ── 3. Per-site ATOMICITY-REMOVAL CONTROL ────────────────────────────────

  it.each(CONSUME_SITES)(
    "$label — without server-side atomicity the SAME receipt is redeemed twice or more",
    async ({ file, anchor }) => {
      const script = extractLuaAfter(file, anchor)
      const key = "consume:control:key"

      // Byte-identical setup to the atomicity case above; only the mechanism
      // differs. If that case were passing for some other reason, this would
      // report one winner too, and fail.
      await harness.client.set(key, RECEIPT)
      const nonAtomic = await Promise.all(
        Array.from({ length: 20 }, () => consumeNonAtomically(key)),
      )
      const nonAtomicWinners = nonAtomic.filter((r) => r !== null)
      expect(nonAtomicWinners.length).toBeGreaterThan(1)
      expect(nonAtomicWinners.every((r) => r === RECEIPT)).toBe(true)

      // And the real script, in the same shape, still admits one.
      await harness.client.set(key, RECEIPT)
      const atomic = await Promise.all(
        Array.from({ length: 20 }, () => consume(script, key)),
      )
      expect(atomic.filter((r) => r !== null)).toEqual([RECEIPT])
    },
  )

  // ── 4. All four sites really are the same script ─────────────────────────

  it("every CONSUME site is the SAME shape up to quoting and whitespace", () => {
    const normalized = new Set(
      CONSUME_SITES.map(({ file, anchor }) =>
        extractLuaAfter(file, anchor)
          .replace(/\s+/g, " ")
          .replace(/"/g, "'")
          .toLowerCase()
          .trim(),
      ),
    )
    expect([...normalized]).toEqual([
      "local value = redis.call('get', keys[1]) if value then redis.call('del', keys[1]) return value else return nil end",
    ])
  })

  // ── 5. The CAD/CONSUME confusion the census flagged ──────────────────────

  it("a CONSUME script run against a lock returns the token and deletes it — CAD's inverse", () => {
    // Census, "The script-blindness hazard": six of the seven eval-emulating
    // doubles ignore the script argument, which is safe only while a SUT reaches
    // one script family. The two families have OPPOSITE contracts, and this is
    // that difference made concrete on real Redis: hand a lock to the CONSUME
    // script and it reports success and frees a lock the caller does not own.
    // Anything that routes a CAD call through a CONSUME emulation asserts the
    // exact inverse of CLAUDE.md rule #10, green.
    const consumeScript = extractLuaAfter(
      CONSUME_SITES[0]!.file,
      CONSUME_SITES[0]!.anchor,
    )
    const key = "consume:family-confusion:lock"
    return (async () => {
      await harness.client.set(key, "owned-by-someone-else")
      expect(await consume(consumeScript, key)).toBe("owned-by-someone-else")
      expect(await harness.client.exists(key)).toBe(0)
    })()
  })
})
