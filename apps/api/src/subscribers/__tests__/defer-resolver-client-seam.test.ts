// R5-S12 — the defer-resolver family's Redis-client seam, born guarded.
//
// The seam is `DeferResolverRedis`: `resolveDeferredSession`,
// `startDeferResolverSubscriber` and `lib/defer-resuming-lock.ts` all accept a
// client and default to today's process singleton, resolved at the same point
// it always was.
//
// A seam test that only injects a client proves nothing — the module could
// ignore the argument and resolve the singleton, and every assertion would
// still pass because the test's own double IS the singleton. So this file runs
// a control/treatment pair over TWO distinct clients:
//
//   - `decoy`   — what `getRedisClient()` returns. Nothing in these tests may
//                 touch it.
//   - `injected` — what the seam is handed.
//
// Every case asserts the work landed on `injected` AND that `decoy` was never
// touched. Delete the `?? (await getRedisClient())` threading and the module
// silently falls back to `decoy`: `injected` goes untouched and each case reds
// on the property named in its own title. That is the revert-to-red.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"

// Assigned in beforeEach. The `vi.mock` factory below closes over it lazily —
// it is only read when `getRedisClient()` is actually CALLED, which in a
// correctly-threaded module is never.
let decoy: InMemoryRedis

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: vi.fn(async () => {}),
  publishNatsEvent: vi.fn(async () => {}),
}))

// Spread the REAL module and replace ONLY the client resolver. `rk` stays real
// (Hard Rule #7) so the keys under assertion are the ones production writes.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>()
  return { ...real, getRedisClient: vi.fn(async () => decoy.client) }
})

function paymentConfirmed(): PaymentStatusChangedEvent {
  return {
    orderId: "order_seam",
    paymentId: "pay_seam",
    previousStatus: "payment_pending",
    newStatus: "paid",
    method: "pix",
    version: 2,
    timestamp: "2026-08-04T00:00:00.000Z",
  } as PaymentStatusChangedEvent
}

beforeEach(() => {
  vi.clearAllMocks()
  decoy = createInMemoryRedis()
})

describe("R5-S12 — resolveDeferredSession drives the INJECTED client", () => {
  it("reads the parked key from the injected keyspace and never touches the singleton", async () => {
    const injected = createInMemoryRedis()
    const { resolveDeferredSession } = await import("../defer-resolver.js")

    const result = await resolveDeferredSession({
      sessionId: "sess_seam",
      signal: "pix.confirmed",
      event: paymentConfirmed(),
      redis: injected.client,
    })

    // The GET landed on the injected client...
    expect(injected.calls.map((c) => c.command)).toContain("get")
    // ...and the singleton was never consulted at all.
    expect(decoy.calls).toHaveLength(0)
    // An empty injected keyspace really is what it read.
    expect(result.kind).toBe("no_park")
  })

  it("reads the rk()-prefixed key production writes, through the REAL rk", async () => {
    const { rk } = await import("@ibatexas/tools")
    const injected = createInMemoryRedis()
    const { resolveDeferredSession } = await import("../defer-resolver.js")

    await resolveDeferredSession({
      sessionId: "sess_key",
      signal: "pix.confirmed",
      event: paymentConfirmed(),
      redis: injected.client,
    })

    const getKeys = injected.calls
      .filter((c) => c.command === "get")
      .map((c) => c.args[0])
    expect(getKeys).toContain(rk("defer:pending:sess_key"))
    expect(decoy.calls).toHaveLength(0)
  })

  it("resolves the singleton when NO client is threaded (the default is preserved)", async () => {
    const { resolveDeferredSession } = await import("../defer-resolver.js")

    const result = await resolveDeferredSession({
      sessionId: "sess_default",
      signal: "pix.confirmed",
      event: paymentConfirmed(),
    })

    // This is the control for the two cases above: with no `redis` argument the
    // module MUST fall back, so the decoy is the client that gets used. If this
    // case ever goes green alongside a broken default, the pair above is
    // measuring nothing.
    expect(decoy.calls.map((c) => c.command)).toContain("get")
    expect(result.kind).toBe("no_park")
  })
})

describe("R5-S12 — the defer-resuming lock drives the INJECTED client", () => {
  it("acquires with SET NX on the injected client, not the singleton", async () => {
    const injected = createInMemoryRedis()
    const { acquireDeferResumingLock } = await import("../../lib/defer-resuming-lock.js")

    const res = await acquireDeferResumingLock(
      "test:defer:resuming:h1",
      30,
      "resolver",
      injected.client,
    )

    expect(res.acquired).toBe(true)
    expect(res.lockValue).toMatch(/^resolver:/)
    expect(injected.peek("test:defer:resuming:h1")).toBe(res.lockValue)
    expect(decoy.calls).toHaveLength(0)
  })

  it("a second acquire on the SAME injected keyspace is refused (the NX is real)", async () => {
    const injected = createInMemoryRedis()
    const { acquireDeferResumingLock } = await import("../../lib/defer-resuming-lock.js")

    const first = await acquireDeferResumingLock("test:k", 30, "resolver", injected.client)
    const second = await acquireDeferResumingLock("test:k", 30, "sweeper", injected.client)

    expect(first.acquired).toBe(true)
    expect(second).toEqual({ acquired: false, lockValue: null })
    expect(decoy.calls).toHaveLength(0)
  })

  it("release issues its EVAL on the INJECTED client, and swallows the W4-RULE-3 refusal", async () => {
    const injected = createInMemoryRedis()
    // A SPY-DELEGATE, not a stand-in: the spy forwards to the adapter's own
    // `eval`, which REFUSES (LuaAtomicityNotEmulated) exactly as it does for
    // every other caller. The spy exists only so the call is observable —
    // the adapter's refusal is not recorded in `calls`, so without this the
    // test could not tell an injected release from a singleton one, and its
    // title would be the untested part.
    const evalSpy = vi.fn((...args: unknown[]) =>
      (injected.client as unknown as { eval: (...a: unknown[]) => unknown }).eval(...args),
    )
    const client = {
      set: injected.client.set.bind(injected.client),
      eval: evalSpy,
    } as unknown as Parameters<
      typeof import("../../lib/defer-resuming-lock.js").releaseDeferResumingLock
    >[2]

    const { releaseDeferResumingLock } = await import("../../lib/defer-resuming-lock.js")

    // Best-effort by design: the helper swallows the refusal. This pins that
    // the refusal reached the INJECTED client; it does NOT claim the
    // compare-and-delete invariant is covered — that one is owner-gated on the
    // real-Redis decision (see __tests__/helpers/redis-double-census.md).
    await expect(
      releaseDeferResumingLock("test:k", "resolver:uuid", client),
    ).resolves.toBeUndefined()

    expect(evalSpy).toHaveBeenCalledTimes(1)
    expect(evalSpy).toHaveBeenCalledWith(expect.stringContaining("redis.call('GET'"), {
      keys: ["test:k"],
      arguments: ["resolver:uuid"],
    })
    expect(decoy.calls).toHaveLength(0)
  })
})
