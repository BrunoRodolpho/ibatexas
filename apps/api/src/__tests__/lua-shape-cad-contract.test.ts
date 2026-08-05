// M1 — THE CAD SHAPE CONTRACT. Compare-and-delete, every production site. REAL REDIS.
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2 — "coverage is
// organized by SCRIPT SHAPE, not by file"). Model: park-nx-release-failure-mode.test.ts.
//
// THE SHAPE
//   if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1])
//   else return 0 end
//
// THE CONTRACT, in one sentence: a caller may delete the key only while the key
// still holds the caller's own token. This is CLAUDE.md rule #10, and it is the
// only thing standing between "my lock lapsed" and "I destroyed the lock its new
// owner is holding right now".
//
// ── What makes this a SHAPE suite and not an eleventh site suite ─────────────
//
// The repo already has site suites for four CAD sites (cart-create-lock-ownership,
// checkout-idem-gate-ownership, agent-trigger-dedup-ownership,
// execution-queue-release-fallback, park-nx-release-failure-mode). Each drives
// production FUNCTIONS and proves that site releases correctly. None of them can
// see a divergent script at a site they do not cover — and there are ELEVEN CAD
// sites, in FOUR packages.
//
// This file inverts that. It reads the Lua TEXT out of each of the eleven
// production sites (`extractLuaAfter`, see helpers/lua-script-sources.ts) and
// runs the identical contract against every one of them on a real Redis. A site
// that drops `== ARGV[1]`, swaps DEL for UNLINK-unconditional, or is copy-pasted
// wrong reds HERE, at the site's own row, whether or not that site has a suite.
//
// Reading source rather than importing is also what lets one suite cover
// `packages/tools`, `packages/cli` and `packages/journeys` sites without adding
// a single dependency edge to apps/api.
//
// ── Why the per-site CONTROL block exists ────────────────────────────────────
//
// "The suite must fail if the ownership conjunct is removed" is a claim about
// this suite, so this suite proves it rather than asserting it. For EVERY site,
// `stripOwnershipGuard` rewrites that site's own extracted script into the
// unconditional-DEL version the F-21/F-22 defects actually shipped, and the
// control requires that version to DESTROY the foreign owner's value. If the
// contract case above it were vacuous — wrong key, absent key, a value that was
// never really foreign — the control would fail too, because it runs the same
// setup and only the ownership conjunct differs.
//
// Gated by RUN_REAL_REDIS; enrolled in the M0 roll call
// (scripts/check-real-redis-suites.mjs) so it cannot skip in CI unnoticed.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  COMPARE_AND_DELETE_SCRIPT,
  EVAL_INCR_CHECK_SCRIPT,
} from "../adapters/park-redis-capabilities.js"
import { TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT } from "../claustrum/trigger-dedup-redis.js"
import { extractLuaAfter } from "./helpers/lua-script-sources.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

interface LuaSite {
  /** Stable name; pinned by the hand-written roll call below. */
  readonly label: string
  readonly file: string
  readonly anchor: string
}

/**
 * THE ELEVEN PRODUCTION CAD SITES — hand-written, from the census inventory
 * (`helpers/redis-double-census.md`, "The full production Lua inventory") plus
 * the one that inventory missed: `claustrum/trigger-dedup-redis.ts`. The census
 * listed TEN; the grep for `redis.call` over the current tree returns ELEVEN.
 * That correction is recorded in the census by this slice.
 */
const CAD_SITES: readonly LuaSite[] = [
  {
    label: "streaming/execution-queue — web agent lock release",
    file: "apps/api/src/streaming/execution-queue.ts",
    anchor: "const RELEASE_LOCK_SCRIPT =",
  },
  {
    label: "adapters/park-redis-capabilities — NX placeholder release",
    file: "apps/api/src/adapters/park-redis-capabilities.ts",
    anchor: "export const COMPARE_AND_DELETE_SCRIPT =",
  },
  {
    label: "lib/defer-resuming-lock — resume mutex release",
    file: "apps/api/src/lib/defer-resuming-lock.ts",
    anchor: "const RELEASE_LOCK_SCRIPT =",
  },
  {
    label: "jobs/outbox-retry — job lock release (inline literal)",
    file: "apps/api/src/jobs/outbox-retry.ts",
    anchor: "// Conditional Lua release: only delete the key if we still own it.",
  },
  {
    label: "jobs/anonymize-medusa-retry — job lock release (inline literal)",
    file: "apps/api/src/jobs/anonymize-medusa-retry.ts",
    anchor: "// Conditional Lua release — only delete if we still own it.",
  },
  {
    label: "claustrum/trigger-dedup-redis — trigger claim release",
    file: "apps/api/src/claustrum/trigger-dedup-redis.ts",
    anchor: "export const TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT =",
  },
  {
    label: "routes/me/anonymize-active-lock — LGPD anonymize lock release",
    file: "apps/api/src/routes/me/anonymize-active-lock.ts",
    anchor: "const RELEASE_LOCK_SCRIPT =",
  },
  {
    label: "whatsapp/session — agent lock release",
    file: "apps/api/src/whatsapp/session.ts",
    anchor: "const RELEASE_LOCK_SCRIPT =",
  },
  {
    label: "packages/tools distributed-lock — shared lock release",
    file: "packages/tools/src/redis/distributed-lock.ts",
    anchor: "const RELEASE_LOCK_SCRIPT =",
  },
  {
    label: "packages/cli lock — CLI command lock release",
    file: "packages/cli/src/lib/lock.ts",
    anchor: "const RELEASE_LOCK_SCRIPT =",
  },
  {
    label: "packages/journeys journey-lock — journey serialization release",
    file: "packages/journeys/src/runner/journey-lock.ts",
    anchor: "const RELEASE_LOCK_SCRIPT =",
  },
]

/**
 * NAME PIN — typed out by hand, deliberately NOT derived from `CAD_SITES`.
 *
 * F-14: a roll call generated from the table it polices cannot fail, because
 * deleting a row deletes its own coverage requirement. These strings are the
 * independent copy. Dropping a site from `CAD_SITES` reds the first case below;
 * adding one without recording it here does too.
 */
const CAD_SITE_ROLL_CALL: readonly string[] = [
  "streaming/execution-queue — web agent lock release",
  "adapters/park-redis-capabilities — NX placeholder release",
  "lib/defer-resuming-lock — resume mutex release",
  "jobs/outbox-retry — job lock release (inline literal)",
  "jobs/anonymize-medusa-retry — job lock release (inline literal)",
  "claustrum/trigger-dedup-redis — trigger claim release",
  "routes/me/anonymize-active-lock — LGPD anonymize lock release",
  "whatsapp/session — agent lock release",
  "packages/tools distributed-lock — shared lock release",
  "packages/cli lock — CLI command lock release",
  "packages/journeys journey-lock — journey serialization release",
]

const OUR_TOKEN = "11111111-1111-4111-8111-111111111111"
/** A token written by SOMEONE ELSE. Nothing in this file may ever delete it. */
const FOREIGN_TOKEN = "99999999-9999-4999-8999-999999999999"

/**
 * Rewrite a CAD script into the unconditional-DEL version — i.e. delete the
 * ownership conjunct and nothing else. Throws when the guard is not found, so a
 * regex that stops matching can never quietly turn the controls into re-runs of
 * the unmutated script.
 */
function stripOwnershipGuard(script: string): string {
  const guard = /redis\.call\((['"])GET\1,\s*KEYS\[1\]\)\s*==\s*ARGV\[1\]/i
  if (!guard.test(script)) {
    throw new Error(
      `stripOwnershipGuard found no CAD guard to remove in: ${JSON.stringify(script)}`,
    )
  }
  return script.replace(guard, "true")
}

describe.skipIf(!RUN_REAL_REDIS)("Lua shape contract — CAD (real Redis)", () => {
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

  const evalCad = async (script: string, key: string, token: string): Promise<number> =>
    (await harness.client.eval(script, {
      keys: [key],
      arguments: [token],
    })) as number

  // ── 0. The population is pinned by hand ───────────────────────────────────

  it("the CAD site table matches the hand-written roll call, site for site", () => {
    expect(CAD_SITES.map((s) => s.label)).toEqual(CAD_SITE_ROLL_CALL)
    // The census inventory said 10. It missed claustrum/trigger-dedup-redis.
    expect(CAD_SITES).toHaveLength(11)
  })

  it("the extractor agrees with ground truth where ground truth exists", () => {
    // Only three Lua constants in the repo are EXPORTED, so only three can be
    // compared against an import. If `extractLuaAfter` were returning something
    // other than the production text, these would diverge. This is the control
    // on the mechanism every other case in this file depends on.
    expect(
      extractLuaAfter(
        "apps/api/src/adapters/park-redis-capabilities.ts",
        "export const COMPARE_AND_DELETE_SCRIPT =",
      ),
    ).toBe(COMPARE_AND_DELETE_SCRIPT)
    expect(
      extractLuaAfter(
        "apps/api/src/claustrum/trigger-dedup-redis.ts",
        "export const TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT =",
      ),
    ).toBe(TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT)
    expect(
      extractLuaAfter(
        "apps/api/src/adapters/park-redis-capabilities.ts",
        "export const EVAL_INCR_CHECK_SCRIPT =",
      ),
    ).toBe(EVAL_INCR_CHECK_SCRIPT)
  })

  // ── 1. The contract, at every site ────────────────────────────────────────

  it.each(CAD_SITES)("$label obeys the CAD contract", async ({ file, anchor }) => {
    const script = extractLuaAfter(file, anchor)
    const key = "cad:contract:key"
    const neighbour = "cad:contract:neighbour"

    // (a) The holder releases: returns 1, key gone.
    await harness.client.set(key, OUR_TOKEN)
    await harness.client.set(neighbour, "untouched")
    expect(await evalCad(script, key, OUR_TOKEN)).toBe(1)
    expect(await harness.client.exists(key)).toBe(0)

    // (b) THE PROPERTY: a non-holder does NOT delete. Returns 0, value intact.
    await harness.client.set(key, FOREIGN_TOKEN)
    expect(await evalCad(script, key, OUR_TOKEN)).toBe(0)
    expect(await harness.client.get(key)).toBe(FOREIGN_TOKEN)

    // (c) Absent key: 0, and the script does not create it.
    await harness.client.del(key)
    expect(await evalCad(script, key, OUR_TOKEN)).toBe(0)
    expect(await harness.client.exists(key)).toBe(0)

    // (d) Blast radius is exactly KEYS[1].
    expect(await harness.client.get(neighbour)).toBe("untouched")
  })

  // ── 2. Per-site CONJUNCT-REMOVAL CONTROL ─────────────────────────────────

  it.each(CAD_SITES)(
    "$label — with the ownership conjunct REMOVED, the foreign value is destroyed",
    async ({ file, anchor }) => {
      const script = extractLuaAfter(file, anchor)
      const mutated = stripOwnershipGuard(script)
      expect(mutated).not.toBe(script)

      const key = "cad:control:key"
      // Byte-identical end state to arm (b) above.
      await harness.client.set(key, FOREIGN_TOKEN)
      expect(await harness.client.get(key)).toBe(FOREIGN_TOKEN)

      // The unconditional-DEL version — what F-21 shipped and F-22 deleted.
      expect(await evalCad(mutated, key, OUR_TOKEN)).toBe(1)
      expect(await harness.client.exists(key)).toBe(0)
    },
  )

  // ── 3. Atomicity — the property no in-process double can provide ─────────

  it("concurrent releases of one key admit EXACTLY ONE deleter", async () => {
    // Q3: bounded iteration, invariant asserted per iteration — not a 100x race.
    const script = extractLuaAfter(CAD_SITES[0]!.file, CAD_SITES[0]!.anchor)
    const key = "cad:atomicity:key"

    for (let round = 0; round < 5; round += 1) {
      await harness.client.set(key, OUR_TOKEN)
      const results = await Promise.all(
        Array.from({ length: 20 }, () => evalCad(script, key, OUR_TOKEN)),
      )
      expect(results.filter((r) => r === 1)).toHaveLength(1)
      expect(results.filter((r) => r === 0)).toHaveLength(19)
      expect(await harness.client.exists(key)).toBe(0)
    }
  })

  it("a lapsed holder racing the new owner never deletes the new owner's key", async () => {
    // The scenario the shape exists for, end to end: our TTL lapsed, someone
    // else acquired, and our release lands late.
    const script = extractLuaAfter(CAD_SITES[0]!.file, CAD_SITES[0]!.anchor)
    const key = "cad:lapsed:key"

    for (let round = 0; round < 5; round += 1) {
      await harness.client.set(key, OUR_TOKEN, { PX: 40 })
      await new Promise((r) => setTimeout(r, 60))
      expect(await harness.client.exists(key)).toBe(0) // our lock really lapsed

      await harness.client.set(key, FOREIGN_TOKEN, { EX: 60 })
      expect(await evalCad(script, key, OUR_TOKEN)).toBe(0)
      expect(await harness.client.get(key)).toBe(FOREIGN_TOKEN)
      await harness.client.del(key)
    }
  })

  // ── 4. All eleven sites really are the same script ───────────────────────

  it("every CAD site is the SAME shape up to quoting and whitespace", async () => {
    // Not a style check — it is what licenses call sites to inherit this
    // contract. A site that normalizes to something else is a different script
    // wearing the shape's name, and the per-site cases above would be the only
    // thing covering it.
    const normalized = new Set(
      CAD_SITES.map(({ file, anchor }) =>
        extractLuaAfter(file, anchor)
          .replace(/\s+/g, " ")
          .replace(/"/g, "'")
          .toLowerCase()
          .trim(),
      ),
    )
    expect([...normalized]).toEqual([
      "if redis.call('get', keys[1]) == argv[1] then return redis.call('del', keys[1]) else return 0 end",
    ])
  })
})
