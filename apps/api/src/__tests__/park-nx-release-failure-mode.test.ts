// F-22 — the NX placeholder release, and the composed quota seam. REAL REDIS.
//
// ── Why a container and not a double ─────────────────────────────────────────
//
// Both properties under test are Redis SERVER-side atomicity:
//
//   • "delete this key only while its value is still my token" has to be one
//     indivisible step, because the whole point is that another owner may have
//     claimed the key in between.
//   • "increment, refresh the TTL, and refuse past the cap" has to be one
//     indivisible step, because the whole point is that concurrent parks must
//     not both squeeze past `quota − 1`.
//
// A JS Map-stub of `eval()` decides both in our own process and hands back
// green on a path with no real coverage (W4 RULE 3 — which is why
// `createInMemoryRedis` REFUSES `eval` outright). The unit layer
// (`src/adapters/__tests__/park-redis-capabilities.unit.test.ts`) proves the
// SHAPE — fail-closed composition, the right script and arguments — and this
// file proves the SEMANTICS. Harness idiom follows
// `src/__tests__/cart-create-lock-ownership.test.ts` (F-21).
//
// ── The defect being regressed ───────────────────────────────────────────────
//
// `releaseNxPlaceholder` feature-detected `eval` and, on a detect-miss OR on
// the eval THROWING, fell through to an unconditional `del(parkKey)`:
//
//     if (typeof r.eval === "function") {
//       try { await r.eval(RELEASE_PLACEHOLDER_SCRIPT, {...}); return }
//       catch { /* Fall through to plain del — TTL is the ultimate safety net */ }
//     }
//     await r.del?.(parkKey)?.catch(() => {})
//
// Both call sites are ERROR paths, and the likeliest cause of a mid-flight park
// failure — a Redis blip — is also the likeliest cause of the EVAL failing. So
// in exactly the failure mode the compare-and-delete was written for, the CAD
// was skipped and a blind DEL ran against a key another owner may by then hold.
//
// F-22 deletes both branches. Release is the CAD, always; when the CAD FAILS
// the key is deliberately LEFT to its TTL. That is a behaviour change in the
// failure mode, and the first three cases below are its proof.
//
// Gated by RUN_REAL_REDIS like every other real-Redis suite here: CI runs the
// container; local dev may opt out with `IBX_SKIP_REAL_REDIS=1`.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  DEFER_PENDING_TTL_GRACE_SECONDS,
  deferCounterKey,
  deferParkKey,
} from "@adjudicate/runtime"
import {
  createParkRedisCapabilities,
  parkDeferredIntentWithNxGuard,
  type ParkDeferredIntentNxArgs,
  type ParkRedisCapabilities,
} from "../adapters/park-deferred-intent-nx.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

const PREFIX = "f22-park-release:"
const rk = (key: string): string => `${PREFIX}${key}`

/** A value written by SOMEONE ELSE. Nothing in this file may ever delete it. */
const FOREIGN_OWNER_VALUE = '{"owner":"another-caller","real":true}'

function buildTestEnvelope(sessionId: string, nonce: string): IntentEnvelope {
  return buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: `ord_${nonce}` },
    actor: { sessionId, principal: "llm" },
    taint: "UNTRUSTED",
    nonce,
  }) as IntentEnvelope
}

function parkArgs(
  redis: ParkRedisCapabilities,
  envelope: IntentEnvelope,
  overrides: Partial<ParkDeferredIntentNxArgs> = {},
): ParkDeferredIntentNxArgs {
  return {
    envelope: {
      intentHash: envelope.intentHash,
      kind: envelope.kind,
      actor: { sessionId: envelope.actor.sessionId },
      payload: envelope.payload,
      version: envelope.version,
      nonce: envelope.nonce,
      taint: envelope.taint,
      actorPrincipal: envelope.actor.principal,
      origin: envelope.origin,
    },
    signal: "payment.confirmed",
    ttlSeconds: 120,
    redis,
    rk,
    ...overrides,
  }
}

describe.skipIf(!RUN_REAL_REDIS)("F-22 park release + quota seam (real Redis)", () => {
  let harness: RedisTestHarness
  let base: ParkRedisCapabilities

  beforeAll(async () => {
    harness = await setupRedisTestContainer()
    // The PRODUCTION composition root, over a real client.
    base = createParkRedisCapabilities(harness.client)
  }, 120_000)

  afterAll(async () => {
    await harness?.teardown()
  })

  beforeEach(async () => {
    await harness.client.flushAll()
  })

  // ── (a) The F-22 scenario: the release FAILS ──────────────────────────────

  it("a failed CAD release leaves the placeholder key to its TTL — it is NOT deleted", async () => {
    const sessionId = "sess_f22_ttl"
    const envelope = buildTestEnvelope(sessionId, "TTL")
    const parkKey = rk(deferParkKey(sessionId))

    let setCalls = 0
    const blipping: ParkRedisCapabilities = {
      ...base,
      // Call 1 is our own SETNX placeholder (let it through). Call 2 is the
      // framework's payload SET — that is the mid-flight Redis blip.
      set: async (key, value, options) => {
        setCalls += 1
        if (setCalls >= 2) throw new Error("READONLY You can't write against a replica")
        return base.set(key, value, options)
      },
      // The SAME blip takes down the release's EVAL. This is the pairing the
      // deleted fallback got wrong.
      compareAndDelete: async () => {
        throw new Error("LOADING Redis is loading the dataset in memory")
      },
    }

    await expect(
      parkDeferredIntentWithNxGuard(parkArgs(blipping, envelope)),
    ).rejects.toThrow(/READONLY/)

    // The key SURVIVES, with its TTL intact. Pre-F-22 the catch ran a blind
    // DEL and this was 0 / -2.
    expect(await harness.client.exists(parkKey)).toBe(1)
    const ttl = await harness.client.ttl(parkKey)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(120)
    // And it is still OUR placeholder — nothing rewrote it.
    const stored = JSON.parse((await harness.client.get(parkKey)) as string) as {
      __nx_placeholder__?: boolean
    }
    expect(stored.__nx_placeholder__).toBe(true)
  })

  it("a failed CAD release NEVER deletes a key a foreign owner has since claimed", async () => {
    const sessionId = "sess_f22_foreign"
    const envelope = buildTestEnvelope(sessionId, "FOREIGN")
    const parkKey = rk(deferParkKey(sessionId))

    let setCalls = 0
    const blipping: ParkRedisCapabilities = {
      ...base,
      set: async (key, value, options) => {
        setCalls += 1
        if (setCalls >= 2) {
          // The race the CAD exists for: another caller claims the slot
          // between our SETNX and our cleanup, and THEN our park throws.
          await harness.client.set(parkKey, FOREIGN_OWNER_VALUE, { EX: 300 })
          throw new Error("READONLY You can't write against a replica")
        }
        return base.set(key, value, options)
      },
      compareAndDelete: async () => {
        throw new Error("LOADING Redis is loading the dataset in memory")
      },
    }

    await expect(
      parkDeferredIntentWithNxGuard(parkArgs(blipping, envelope)),
    ).rejects.toThrow(/READONLY/)

    // THE property. Pre-F-22 the blind DEL destroyed this.
    expect(await harness.client.get(parkKey)).toBe(FOREIGN_OWNER_VALUE)
  })

  it("control — the pre-F-22 release, verbatim, DOES destroy the foreign owner's key", async () => {
    // Without this the case above could be passing for the wrong reason (e.g.
    // if the sequence never actually let the foreign owner take the key). This
    // runs the IDENTICAL end state and swaps ONLY the release mechanism for
    // the one F-22 removed; it MUST show the damage.
    const sessionId = "sess_f22_control"
    const parkKey = rk(deferParkKey(sessionId))
    await harness.client.set(parkKey, FOREIGN_OWNER_VALUE, { EX: 300 })
    expect(await harness.client.get(parkKey)).toBe(FOREIGN_OWNER_VALUE)

    // The deleted code, verbatim: feature-detect, try the eval, and on a throw
    // fall through to an unconditional del.
    const r = {
      eval: async (): Promise<unknown> => {
        throw new Error("LOADING Redis is loading the dataset in memory")
      },
      del: (k: string): Promise<number> => harness.client.del(k),
    }
    if (typeof r.eval === "function") {
      try {
        await r.eval()
      } catch {
        /* Fall through to plain del — TTL is the ultimate safety net. */
      }
    }
    await r.del(parkKey).catch(() => {})

    expect(await harness.client.get(parkKey)).toBeNull()
  })

  // ── (b) The release still WORKS on the normal path ────────────────────────

  it("the quota-exceeded path compare-and-deletes OUR OWN placeholder", async () => {
    const sessionId = "sess_f22_quota_release"
    const envelope = buildTestEnvelope(sessionId, "QUOTAREL")
    const parkKey = rk(deferParkKey(sessionId))
    const counterKey = rk(deferCounterKey(sessionId))

    // Seed the counter past the cap so the framework refuses the park and the
    // wrapper takes its release branch.
    await harness.client.set(counterKey, "99")

    const result = await parkDeferredIntentWithNxGuard(
      parkArgs(base, envelope, { quotaPerSession: 1 }),
    )

    expect(result.parked).toBe(false)
    if (result.parked === false) expect(result.reason).toBe("quota_exceeded")

    // Released: the slot is free for the next legitimate DEFER.
    expect(await harness.client.exists(parkKey)).toBe(0)
  })

  it("the working release is OWNERSHIP-CHECKED — it leaves a foreign value alone", async () => {
    // The CAD's whole purpose, and (per the census) previously untested: the
    // release runs successfully, but the key is no longer ours.
    const sessionId = "sess_f22_owner_check"
    const envelope = buildTestEnvelope(sessionId, "OWNERCHK")
    const parkKey = rk(deferParkKey(sessionId))

    const hijacking: ParkRedisCapabilities = {
      ...base,
      // Runs after our SETNX, before the release. Claim the slot for someone
      // else, then report quota-exceeded so the wrapper releases.
      evalIncrCheck: async () => {
        await harness.client.set(parkKey, FOREIGN_OWNER_VALUE, { EX: 300 })
        return 0
      },
    }

    const result = await parkDeferredIntentWithNxGuard(
      parkArgs(hijacking, envelope, { quotaPerSession: 1 }),
    )
    expect(result.parked).toBe(false)

    // The CAD ran and returned 0 — value mismatch, nothing deleted.
    expect(await harness.client.get(parkKey)).toBe(FOREIGN_OWNER_VALUE)
  })

  // ── (c) The composed quota seam is the one the framework uses ─────────────

  it("the framework consumes OUR evalIncrCheck — its non-atomic INCR fallback never runs", async () => {
    const sessionId = "sess_f22_seam"
    const envelope = buildTestEnvelope(sessionId, "SEAM")
    const counterKey = rk(deferCounterKey(sessionId))

    // Spy-delegate: real semantics, observable calls.
    const evalIncrCheck = vi.fn(base.evalIncrCheck.bind(base))
    const incr = vi.fn(base.incr.bind(base))
    const expire = vi.fn(base.expire.bind(base))
    const observed: ParkRedisCapabilities = { ...base, evalIncrCheck, incr, expire }

    const result = await parkDeferredIntentWithNxGuard(
      parkArgs(observed, envelope, { quotaPerSession: 16 }),
    )
    expect(result.parked).toBe(true)

    // The atomic seam was taken, with the framework's own arguments.
    expect(evalIncrCheck).toHaveBeenCalledTimes(1)
    expect(evalIncrCheck).toHaveBeenCalledWith(
      counterKey,
      DEFER_PENDING_TTL_GRACE_SECONDS,
      16,
    )
    // …and the fallback's first two commands were NEVER issued. This is the
    // load-bearing observation: `parkDeferredIntent`'s `typeof
    // args.redis.evalIncrCheck === "function"` branch is deterministically
    // TRUE in this repo, so its non-atomic path is dead code here.
    expect(incr).not.toHaveBeenCalled()
    expect(expire).not.toHaveBeenCalled()

    // The counter really moved, and carries the grace TTL.
    expect(await harness.client.get(counterKey)).toBe("1")
    expect(await harness.client.ttl(counterKey)).toBeGreaterThan(0)
  })

  it("evalIncrCheck is ATOMIC — 40 concurrent claims against a cap of 10 admit exactly 10", async () => {
    const counterKey = rk("f22:atomicity:counter")

    const results = await Promise.all(
      Array.from({ length: 40 }, () => base.evalIncrCheck(counterKey, 60, 10)),
    )

    const admitted = results.filter((r) => r !== 0)
    const refused = results.filter((r) => r === 0)
    expect(admitted).toHaveLength(10)
    expect(refused).toHaveLength(30)
    // Every admitted claim got a distinct count 1..10 — no two callers saw the
    // same slot. The framework's INCR→check→DECR fallback cannot promise this.
    expect([...admitted].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
    // The counter settled exactly at the cap — every refusal rolled back.
    expect(await harness.client.get(counterKey)).toBe("10")
  })

  it("evalIncrCheck refreshes the counter TTL on every accepted claim", async () => {
    const counterKey = rk("f22:atomicity:ttl")
    await base.evalIncrCheck(counterKey, 30, 10)
    const first = await harness.client.ttl(counterKey)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThanOrEqual(30)

    await base.evalIncrCheck(counterKey, 600, 10)
    const second = await harness.client.ttl(counterKey)
    // Unconditional EXPIRE (not EXPIRE NX): the counter outlives the LATEST
    // park's grace window, not the first one's.
    expect(second).toBeGreaterThan(first)
  })

  // ── The happy path is unchanged ───────────────────────────────────────────

  it("a normal park still writes the real envelope and keeps the slot claimed", async () => {
    const sessionId = "sess_f22_happy"
    const envelope = buildTestEnvelope(sessionId, "HAPPY")
    const parkKey = rk(deferParkKey(sessionId))

    const result = await parkDeferredIntentWithNxGuard(parkArgs(base, envelope))
    expect(result.parked).toBe(true)

    const stored = JSON.parse((await harness.client.get(parkKey)) as string) as {
      envelope: { intentHash: string }
      __nx_placeholder__?: boolean
    }
    // The framework's payload replaced our placeholder.
    expect(stored.__nx_placeholder__).toBeUndefined()
    expect(stored.envelope.intentHash).toBe(envelope.intentHash)

    // A second DEFER for the same session still collides (guard intact).
    const second = await parkDeferredIntentWithNxGuard(
      parkArgs(base, buildTestEnvelope(sessionId, "HAPPY2")),
    )
    expect(second.parked).toBe(false)
    if (second.parked === false) expect(second.reason).toBe("collision")
  })
})
