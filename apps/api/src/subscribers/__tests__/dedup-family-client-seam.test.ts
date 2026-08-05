// R5 rollout, family 3 — the DEDUP family's Redis-client seam, BORN GUARDED.
//
// The family, as the class-(d) remainder map named it:
//
//   subscribers/dedup.ts      `DedupClaimRedis` / `DedupReleaseRedis` / `WithDedupRedis`
//   subscribers/dlq.ts        `DlqRedis`
//   jobs/follow-up-poller.ts  `FollowUpPollerRedis`
//
// The membership rule: the three class-(d) files that were "migratable now" —
// the NATS idempotency guard every subscriber routes through, the DLQ every
// subscriber's failure path routes through, and the one remaining migratable
// poller. `dedup.ts` leads because its contract is FAIL-CLOSED and its blast
// radius is the whole subscriber layer.
//
// ── Why the control/treatment pair ───────────────────────────────────────────
//
// A seam test that only injects a client proves NOTHING: the module could ignore
// the argument and resolve the singleton, and every assertion would still pass
// because the test's own double IS the singleton. So this file runs two DISTINCT
// clients, the pattern `jobs/__tests__/outreach-client-seam.test.ts` established:
//
//   - `decoy`    — what `getRedisClient()` returns. Nothing in an injected case
//                  may touch it.
//   - `injected` — what the seam is handed.
//
// Every injected case asserts the work landed on `injected` AND that `decoy` was
// never touched. Delete a module's `?? (await getRedisClient())` threading and it
// silently falls back to `decoy`: `injected` goes untouched and the case reds on
// the property in its own title.
//
// Each module ALSO carries a DEFAULT case — call it with no deps, and the decoy
// MUST be what gets used. Those arms are the reason the injected ones are not
// vacuous; they are NOT themselves seam evidence (a neutered module keeps them
// green by construction) and are excluded from the revert-to-red counts.
//
// ── Clock discipline ─────────────────────────────────────────────────────────
//
// Every TTL assertion here is an EXACT remaining lifetime on a FROZEN clock.
// `toBeGreaterThan(0)` is the fiction this migration exists to kill — it cannot
// tell a 7-day dedup window from a 7-second one, which is precisely the defect
// R5-S9 found in the audit spill. Against a wall clock the equality is a
// full-suite flake (milliseconds elapse between the module's SET and the read),
// so the clock is injected instead of the assertion being weakened.
//
// ── One bound this file does NOT close ───────────────────────────────────────
//
// The follow-up zset's PRODUCER is `packages/tools/src/intelligence/schedule-follow-up.ts`
// (`zAdd(rk("follow-up:scheduled"), {score, value})`). It cannot be driven here:
// it resolves its client through a RELATIVE import inside the built package
// (`../redis/client.js`), which this file's `vi.mock("@ibatexas/tools")` — a
// mock of the package SPECIFIER — cannot reach. So the seeding below writes the
// zset by hand, and the producer/consumer agreement rides on two independent
// assertions of the same key literal (its own suite pins
// `development:follow-up:scheduled`; this one reads the real `rk`), not on a
// driven path. Recorded as a gap in the census rather than dressed up as a pin.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing"
import type { Job } from "bullmq"

// Assigned in beforeEach. The `vi.mock` factory closes over it LAZILY — it is
// only read when `getRedisClient()` is actually CALLED, which in a correctly
// threaded + injected call is never.
let decoy: InMemoryRedis

const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

// Spread the REAL module and replace ONLY the client resolver. `rk` stays REAL —
// Hard Rule #7 — so every key under assertion is the key production writes.
// Under apps/api's vitest that prefix is `development:`, which is exactly what
// the retired doubles in this family faked as `test:`.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>()
  return { ...real, getRedisClient: vi.fn(async () => decoy.client) }
})

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
  subscribeNatsEvent: vi.fn(async () => {}),
}))

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => {
    cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() })
  }),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}))

/** Captures what `startFollowUpPoller()` actually registers as its processor. */
const registeredProcessors = vi.hoisted(
  () => new Map<string, (job: unknown, token?: unknown) => unknown>(),
)

// Only the BullMQ FACTORIES are replaced. `assertDepsBag` is spread through
// REAL — it is the guard under test in the last describe, and a stubbed copy
// would be testing the stub.
vi.mock("../../jobs/queue.js", async (orig) => {
  const real = await orig<typeof import("../../jobs/queue.js")>()
  return {
    ...real,
    createQueue: vi.fn(() => ({ upsertJobScheduler: vi.fn(), close: vi.fn(), add: vi.fn() })),
    createWorker: vi.fn((name: string, processor: (job: unknown, token?: unknown) => unknown) => {
      registeredProcessors.set(name, processor)
      return { on: vi.fn(), close: vi.fn() }
    }),
  }
})

/** A frozen instant, so every TTL below is an exact equality. */
const FROZEN = 1_700_000_000_000

beforeEach(() => {
  vi.clearAllMocks()
  registeredProcessors.clear()
  decoy = createInMemoryRedis()
  mockPublishNatsEvent.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.resetModules()
})

// ── dedup.ts — the fail-CLOSED NATS idempotency guard ────────────────────────

describe("seam — withDedup drives the INJECTED client", () => {
  it("claims at the SHORT in-flight TTL and promotes to the full 7 days only after the handler returns", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => FROZEN })
    const { withDedup } = await import("../dedup.js")
    const key = rk("nats:processed:evt:ttl")

    let ttlDuringHandler: number | null | undefined
    const result = await withDedup(
      "evt:ttl",
      async () => {
        ttlDuringHandler = injected.ttlMs(key)
      },
      { redis: injected.client },
    )

    expect(result).toBe(true)
    // The two-phase contract, as a KEYSPACE property rather than a call-args
    // assertion: while the handler runs the marker carries the 5-minute claim,
    // and only afterwards does it carry the 7-day dedup window. The retired
    // double asserted `set` was called with `{EX: 300}` — which a module that
    // never wrote anything would also satisfy.
    expect(ttlDuringHandler).toBe(300_000)
    expect(injected.peek(key)).toBe("1")
    expect(injected.ttlMs(key)).toBe(604_800_000)
    expect(decoy.calls).toHaveLength(0)
  })

  it("the NX claim is REAL: a second delivery over the same injected keyspace skips the handler", async () => {
    const injected = createInMemoryRedis()
    const { withDedup } = await import("../dedup.js")
    const handler = vi.fn(async () => {})

    const first = await withDedup("evt:dup", handler, { redis: injected.client })
    const second = await withDedup("evt:dup", handler, { redis: injected.client })

    // The retired double answered `set: mockResolvedValue("OK")`, so NX never
    // ran against a keyspace and "a duplicate is suppressed" was a constant.
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(decoy.calls).toHaveLength(0)
  })

  it("a handler throw RELEASES the claim on the injected keyspace, so a redelivery reprocesses", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis()
    const { withDedup } = await import("../dedup.js")
    const key = rk("nats:processed:evt:boom")

    await expect(
      withDedup("evt:boom", async () => {
        throw new Error("handler blew up")
      }, { redis: injected.client }),
    ).rejects.toThrow("handler blew up")

    // The release is `withDedup` HANDING its client to `releaseClaim` — the
    // `del` half of the union Pick. Drop `del` from the type and this key
    // survives, silently suppressing the event for the full in-flight TTL.
    expect(injected.peek(key)).toBeUndefined()

    // ...and the proof that "released" means what it says: a redelivery runs.
    const retried = vi.fn(async () => {})
    expect(await withDedup("evt:boom", retried, { redis: injected.client })).toBe(true)
    expect(retried).toHaveBeenCalledTimes(1)
    expect(decoy.calls).toHaveLength(0)
  })

  it("[FAIL CLOSED] a claim-phase Redis error SKIPS the handler and raises DedupUnavailableError", async () => {
    const injected = createInMemoryRedis()
    const { withDedup, DedupUnavailableError } = await import("../dedup.js")

    // A deliberate FAILURE INJECTION, not a general-purpose double: every
    // command still forwards to the real adapter except `set`, which rejects
    // the way an unreachable Redis does.
    const dead = new Proxy(injected.client, {
      get(target, prop) {
        if (prop === "set") {
          return async () => {
            throw new Error("ECONNREFUSED")
          }
        }
        return Reflect.get(target, prop) as unknown
      },
    }) as typeof injected.client

    const handler = vi.fn(async () => {})

    await expect(withDedup("evt:down", handler, { redis: dead })).rejects.toBeInstanceOf(
      DedupUnavailableError,
    )

    // THE GUARDED DIRECTION. "Fail closed" here means: when the guard cannot be
    // taken, the side effect does NOT happen — the alternative (fail OPEN) is
    // every replica running the handler unguarded. So the load-bearing assertion
    // is the NEGATIVE one, and a negative is vacuous unless the same handler is
    // shown to run when the guard IS available. That control is the next two
    // lines, in this test rather than another, so neutering the guard cannot
    // leave one arm green.
    expect(handler).not.toHaveBeenCalled()
    expect(await withDedup("evt:down", handler, { redis: injected.client })).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(decoy.calls).toHaveLength(0)
  })

  it("[NOT fail-closed] a PROMOTE failure is swallowed — the handler already ran", async () => {
    const injected = createInMemoryRedis()
    const { withDedup } = await import("../dedup.js")

    // A spy-DELEGATE: `set` wraps the real adapter call and only the SECOND one
    // (the promote) is turned into a failure. The claim is genuine, so the
    // keyspace really does carry the in-flight marker.
    const realSet = injected.client.set.bind(injected.client)
    let setCalls = 0
    const flaky = new Proxy(injected.client, {
      get(target, prop) {
        if (prop === "set") {
          return async (...args: Parameters<typeof realSet>) => {
            setCalls += 1
            if (setCalls === 2) throw new Error("promote failed")
            return realSet(...args)
          }
        }
        return Reflect.get(target, prop) as unknown
      },
    }) as typeof injected.client

    const handler = vi.fn(async () => {})
    // The claim phase fails CLOSED; the promote phase deliberately does NOT —
    // asserting both in one file is what keeps "fail closed" a scoped claim
    // rather than a slogan about the whole module.
    expect(await withDedup("evt:promote", handler, { redis: flaky })).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(setCalls).toBe(2)
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    const { withDedup } = await import("../dedup.js")

    expect(await withDedup("evt:default", async () => {})).toBe(true)

    expect(decoy.calls.map((c) => c.command)).toContain("set")
  })
})

describe("seam — isNewEvent / markProcessed drive the INJECTED client", () => {
  it("isNewEvent writes the FULL dedup window and is a real single-phase NX claim", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => FROZEN })
    const { isNewEvent } = await import("../dedup.js")
    const key = rk("nats:processed:alert:new-order:ord_1")

    expect(await isNewEvent("alert:new-order:ord_1", { redis: injected.client })).toBe(true)
    expect(await isNewEvent("alert:new-order:ord_1", { redis: injected.client })).toBe(false)

    expect(injected.peek(key)).toBe("1")
    // 7 days, exactly — the window the staff-alert suppression rides on.
    expect(injected.ttlMs(key)).toBe(604_800_000)
    expect(decoy.calls).toHaveLength(0)
  })

  it("the two entry points share ONE keyspace: a withDedup claim blocks isNewEvent for that key", async () => {
    const injected = createInMemoryRedis()
    const { withDedup, isNewEvent } = await import("../dedup.js")

    await withDedup("evt:shared", async () => {}, { redis: injected.client })

    // Two disjoint client TYPES, one keyspace. A pair of constant stubs never
    // connects them, so "an event processed by the two-phase guard is also
    // invisible to the single-phase one" was never actually tested.
    expect(await isNewEvent("evt:shared", { redis: injected.client })).toBe(false)
    expect(decoy.calls).toHaveLength(0)
  })

  it("markProcessed promotes an in-flight claim to the full window on the injected keyspace", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => FROZEN })
    const { markProcessed } = await import("../dedup.js")
    const key = rk("nats:processed:evt:confirm")

    // Seed the SHORT claim the way withDedup's phase 1 writes it, then promote.
    await injected.client.set(key, "1", { EX: 300, NX: true })
    expect(injected.ttlMs(key)).toBe(300_000)

    await markProcessed("evt:confirm", { redis: injected.client })

    // No NX, so it overwrites — and the TTL is the observable difference.
    expect(injected.ttlMs(key)).toBe(604_800_000)
    expect(decoy.calls).toHaveLength(0)
  })

  it("isNewEvent PROPAGATES a Redis error (callers decide) — it is NOT fail-closed", async () => {
    const injected = createInMemoryRedis()
    const { isNewEvent, DedupUnavailableError } = await import("../dedup.js")
    const dead = new Proxy(injected.client, {
      get(target, prop) {
        if (prop === "set") {
          return async () => {
            throw new Error("ECONNREFUSED")
          }
        }
        return Reflect.get(target, prop) as unknown
      },
    }) as typeof injected.client

    // The contract difference between the two entry points, pinned: `withDedup`
    // converts a claim failure into a typed fail-closed signal; `isNewEvent`
    // hands the raw error up so its caller can choose. Wrapping this one too
    // would silently change every staff-alert call site's error handling.
    const err = await isNewEvent("alert:err", { redis: dead }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(DedupUnavailableError)
    expect(String(err)).toContain("ECONNREFUSED")
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    const { isNewEvent, markProcessed } = await import("../dedup.js")

    expect(await isNewEvent("alert:default")).toBe(true)
    await markProcessed("evt:default-mark")

    expect(decoy.calls.filter((c) => c.command === "set")).toHaveLength(2)
  })
})

// ── dlq.ts — the cap, pinned as a PROPERTY of the list ───────────────────────

describe("seam — pushToDlq drives the INJECTED client", () => {
  /** Every surviving entry's `id`, newest first (LPUSH order). */
  async function idsIn(redis: InMemoryRedis, key: string): Promise<unknown[]> {
    const raw = await redis.client.lRange(key, 0, -1)
    return raw.map((r) => (JSON.parse(r) as { id?: unknown }).id)
  }

  it("writes the entry as a LIST under the real rk(), with the exact 7-day TTL", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => FROZEN })
    const { pushToDlq } = await import("../dlq.js")
    const key = rk("dlq:order.placed")

    await pushToDlq("order.placed", { id: "ord_1" }, new Error("boom"), undefined, {
      redis: injected.client,
    })

    // The whole Redis block is inside a swallowing catch, so "pushToDlq
    // resolved" is compatible with nothing having been written at all. Read the
    // keyspace.
    expect(await idsIn(injected, key)).toEqual(["ord_1"])
    expect(injected.ttlMs(key)).toBe(604_800_000)
    expect(decoy.calls).toHaveLength(0)
  })

  it("[cap PROPERTY] past the cap the OLDEST entries are the ones dropped", async () => {
    vi.resetModules()
    vi.stubEnv("MAX_DLQ", "3")
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => FROZEN })
    // MAX_DLQ is captured at module load, so the override needs a fresh import.
    const { pushToDlq } = await import("../dlq.js")
    const key = rk("dlq:order.placed")
    const dropped: unknown[] = []
    const log = { error: (meta: unknown) => dropped.push(meta) }

    for (const id of ["e1", "e2", "e3", "e4", "e5"]) {
      await pushToDlq("order.placed", { id }, "err", log, { redis: injected.client })
    }

    // THE PROPERTY, not the call: the list is trimmed AT the boundary and the
    // survivors are the NEWEST three, newest first. `expect(lTrim).toHaveBeen
    // CalledWith(key, 0, 2)` is satisfied by an implementation that keeps the
    // WRONG END — ops would then be paged about week-old failures while the
    // fresh ones fell off, with the call assertion still green.
    expect(await injected.client.lLen(key)).toBe(3)
    expect(await idsIn(injected, key)).toEqual(["e5", "e4", "e3"])
    // Two pushes crossed the cap (the 4th and the 5th), each dropping one.
    expect(dropped).toEqual([
      { event: "order.placed", dropped: 1, cap: 3 },
      { event: "order.placed", dropped: 1, cap: 3 },
    ])
    expect(decoy.calls).toHaveLength(0)
  })

  it("[cap control] at/under the cap NOTHING is dropped and no trim is issued", async () => {
    vi.resetModules()
    vi.stubEnv("MAX_DLQ", "3")
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => FROZEN })
    const { pushToDlq } = await import("../dlq.js")
    const key = rk("dlq:order.placed")

    for (const id of ["e1", "e2", "e3"]) {
      await pushToDlq("order.placed", { id }, "err", undefined, { redis: injected.client })
    }

    // Without this arm the case above is compatible with a module that trims on
    // EVERY push — which would also leave three entries once it stopped.
    expect(await idsIn(injected, key)).toEqual(["e3", "e2", "e1"])
    expect(injected.calls.map((c) => c.command)).not.toContain("lTrim")
    expect(decoy.calls).toHaveLength(0)
  })

  it("the TTL is (re)applied AFTER the trim, so a capped list keeps its 7 days", async () => {
    vi.resetModules()
    vi.stubEnv("MAX_DLQ", "2")
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => FROZEN })
    const { pushToDlq } = await import("../dlq.js")
    const key = rk("dlq:order.placed")

    for (const id of ["e1", "e2", "e3"]) {
      await pushToDlq("order.placed", { id }, "err", undefined, { redis: injected.client })
    }

    expect(await injected.client.lLen(key)).toBe(2)
    expect(injected.ttlMs(key)).toBe(604_800_000)
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    const { rk } = await import("@ibatexas/tools")
    const { pushToDlq } = await import("../dlq.js")

    await pushToDlq("order.placed", { id: "ord_default" }, "err")

    expect(await idsIn(decoy, rk("dlq:order.placed"))).toEqual(["ord_default"])
  })
})

// ── jobs/follow-up-poller.ts — the zset drain ────────────────────────────────

describe("seam — processFollowUps drives the INJECTED client", () => {
  const NOW = FROZEN

  /**
   * Seed the zset the way `schedule-follow-up.ts` writes it. See the file
   * header: the producer itself cannot be driven from here, so this mirrors its
   * `zAdd` shape by hand and the agreement is recorded as a bound, not a pin.
   */
  async function schedule(
    redis: InMemoryRedis,
    key: string,
    customerId: string,
    reason: string,
    fireAtMs: number,
  ): Promise<string> {
    const value = JSON.stringify({
      customerId,
      reason,
      scheduledAt: new Date(fireAtMs).toISOString(),
    })
    await redis.client.zAdd(key, { score: fireAtMs, value })
    return value
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  it("the due window is a REAL score comparison — a future entry is neither published nor removed", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => NOW })
    const key = rk("follow-up:scheduled")
    await schedule(injected, key, "cust_past", "thinking", NOW - 1000)
    const future = await schedule(injected, key, "cust_future", "cart_save", NOW + 3_600_000)
    const { processFollowUps } = await import("../../jobs/follow-up-poller.js")

    await processFollowUps(null, { redis: injected.client })

    // The retired double answered `zRangeByScore: mockResolvedValue([])` for its
    // "not due" case — the score boundary was never involved, so the test could
    // not distinguish "not yet due" from "the poller reads nothing at all".
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1)
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", {
      customerId: "cust_past",
      reason: "thinking",
    })
    // ...and the future entry is STILL SCHEDULED, in the keyspace.
    expect(await injected.client.zRangeByScore(key, 0, NOW + 86_400_000)).toEqual([future])
    expect(decoy.calls).toHaveLength(0)
  })

  it("an entry due EXACTLY now is drained — the boundary is inclusive", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => NOW })
    const key = rk("follow-up:scheduled")
    await schedule(injected, key, "cust_edge", "thinking", NOW)
    const { processFollowUps } = await import("../../jobs/follow-up-poller.js")

    await processFollowUps(null, { redis: injected.client })

    // An exclusive upper bound would leave this entry in the set on every tick
    // for as long as it existed. Nothing about a stubbed array can see that.
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1)
    expect(await injected.client.zRangeByScore(key, 0, NOW + 86_400_000)).toEqual([])
    expect(decoy.calls).toHaveLength(0)
  })

  it("a published entry is REMOVED; a publish failure LEAVES its entry for the next tick", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => NOW })
    const key = rk("follow-up:scheduled")
    await schedule(injected, key, "cust_ok", "thinking", NOW - 2000)
    const stuck = await schedule(injected, key, "cust_fail", "price_concern", NOW - 1000)
    mockPublishNatsEvent.mockImplementation(async (_evt: string, p: { customerId: string }) => {
      if (p.customerId === "cust_fail") throw new Error("NATS unavailable")
    })
    const { processFollowUps } = await import("../../jobs/follow-up-poller.js")

    await processFollowUps(null, { redis: injected.client })

    // The at-least-once property, read off the keyspace rather than off a
    // `zRem` call count: exactly the failed one survives.
    expect(await injected.client.zRangeByScore(key, 0, NOW)).toEqual([stuck])
    expect(decoy.calls).toHaveLength(0)
  })

  it("a malformed member is REMOVED from the injected zset without publishing", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis({ now: () => NOW })
    const key = rk("follow-up:scheduled")
    await injected.client.zAdd(key, { score: NOW - 1000, value: "not-valid-json" })
    const good = await schedule(injected, key, "cust_ok", "thinking", NOW - 500)
    const { processFollowUps } = await import("../../jobs/follow-up-poller.js")

    await processFollowUps(null, { redis: injected.client })

    // Both are gone — the malformed one because it is unparseable, the good one
    // because it published. The zset is empty, so the key itself is gone.
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1)
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", {
      customerId: "cust_ok",
      reason: "thinking",
    })
    expect(await injected.client.zRangeByScore(key, 0, NOW)).toEqual([])
    expect(good).toContain("cust_ok")
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    const { rk } = await import("@ibatexas/tools")
    const key = rk("follow-up:scheduled")
    await schedule(decoy, key, "cust_default", "thinking", NOW - 1000)
    const { processFollowUps } = await import("../../jobs/follow-up-poller.js")

    await processFollowUps(null)

    expect(decoy.calls.map((c) => c.command)).toContain("zRangeByScore")
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", {
      customerId: "cust_default",
      reason: "thinking",
    })
  })
})

// ── F-32 — the BullMQ deps-slot collision, for this family's one processor ───
//
// BullMQ calls a registered processor as `(job, token)` with a lock-token
// STRING, and `processFollowUps(log, deps)`' SECOND slot is the deps bag. The
// collision is not live today — `startFollowUpPoller` registers a one-argument
// wrapper — and the pair below is what keeps that a measured fact rather than a
// comment. The two recorded dead ends still apply: `processor.length === 1` is
// VACUOUS (a defaulted parameter does not count toward `Function.length`), and
// "drive it with a token and assert the singleton was used" is vacuous too,
// because that is what both spellings do.

describe("seam — a BullMQ lock token cannot reach the follow-up poller's deps slot", () => {
  it("[treatment] processFollowUps REFUSES a lock token instead of degrading silently", async () => {
    const { processFollowUps } = await import("../../jobs/follow-up-poller.js")

    // Precisely what BullMQ would do to a bare registration: the Job lands in
    // `log` and the token in `deps`. `("tok").redis` is `undefined`, so without
    // the guard every tick would silently run on the singleton.
    await expect(
      (processFollowUps as unknown as (l: unknown, t: unknown) => Promise<void>)(
        { data: {} } as unknown as Job,
        "tok-1",
      ),
    ).rejects.toThrow(/deps must be an options object, got string/)

    // The refusal happens BEFORE any client is resolved — a wiring error, not a
    // Redis one.
    expect(decoy.calls).toHaveLength(0)
  })

  it("[control] what startFollowUpPoller REGISTERS survives the token BullMQ passes it", async () => {
    const { startFollowUpPoller, stopFollowUpPoller } = await import(
      "../../jobs/follow-up-poller.js"
    )
    startFollowUpPoller()

    const processor = registeredProcessors.get("follow-up-poller")
    expect(processor).toBeDefined()

    // Without this arm the treatment is compatible with a registration that is
    // ALSO broken — it would prove the guard fires, not that production clears
    // it. Register `processFollowUps` bare and this reds.
    await expect(processor!({ data: {} }, "tok-1")).resolves.toBeUndefined()
    // ...and it ran, on the singleton, exactly as production does.
    expect(decoy.calls.map((c) => c.command)).toContain("zRangeByScore")

    await stopFollowUpPoller()
  })
})
