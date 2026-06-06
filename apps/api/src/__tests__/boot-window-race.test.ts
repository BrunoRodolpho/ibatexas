// NEW-P0-X1 — Boot-window race regression test.
//
// Background: `apps/api/src/index.ts` previously called
// `startDeferResolverSubscriber(server.log)` BEFORE invoking
// `setResumeIntentDispatcher(...)`. Between those two awaits the
// module-level `_dispatcher` is `null` — a PIX webhook arriving in
// that window flows through `resolveDeferredSession` → audit emits
// → `defer:resumed:` is marked durably committed → dispatcher never
// fires. Silent data loss on every cold boot.
//
// This test reproduces the race by starting the subscriber WITHOUT
// wiring the dispatcher first, delivering a wire event, and asserting
// the parked envelope is NOT marked resumed (no permanent loss).
//
// The fix passes the dispatcher into `startDeferResolverSubscriber`
// as an explicit parameter, eliminating the boot-window entirely.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn())
const mockAdjudicate = vi.hoisted(() => vi.fn())

interface Entry {
  value: string
  ttl: number
}
const store = new Map<string, Entry>()

function makeRedisStub() {
  return {
    async get(key: string): Promise<string | null> {
      const e = store.get(key)
      return e ? e.value : null
    },
    async set(
      key: string,
      value: string,
      opts?: { NX?: boolean; EX?: number },
    ): Promise<string | null> {
      const exists = store.has(key)
      if (opts?.NX && exists) return null
      store.set(key, { value, ttl: opts?.EX ?? -1 })
      return "OK"
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0
    },
    async ttl(key: string): Promise<number> {
      return store.get(key)?.ttl ?? -2
    },
    async incr(key: string): Promise<number> {
      const e = store.get(key)
      const n = e ? Number.parseInt(e.value, 10) + 1 : 1
      store.set(key, { value: String(n), ttl: e?.ttl ?? -1 })
      return n
    },
    async decr(key: string): Promise<number> {
      const e = store.get(key)
      const n = e ? Number.parseInt(e.value, 10) - 1 : -1
      store.set(key, { value: String(n), ttl: e?.ttl ?? -1 })
      return n
    },
    async expire(key: string, seconds: number): Promise<number> {
      const e = store.get(key)
      if (!e) return 0
      store.set(key, { value: e.value, ttl: seconds })
      return 1
    },
    scanIterator(opts: { MATCH?: string; COUNT?: number }) {
      const pattern = opts.MATCH ?? "*"
      const re = new RegExp(
        "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      )
      const keys = [...store.keys()].filter((k) => re.test(k))
      return (async function* () {
        for (const k of keys) yield k
      })()
    },
    async lPush(_k: string, _v: string): Promise<number> {
      return 1
    },
  }
}
let redisStub: ReturnType<typeof makeRedisStub>

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
  publishNatsEvent: mockPublishNatsEvent,
}))

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => redisStub),
  rk: (key: string) => `test:${key}`,
}))

vi.mock("@adjudicate/core/kernel", async () => {
  const real = await vi.importActual<typeof import("@adjudicate/core/kernel")>(
    "@adjudicate/core/kernel",
  )
  return { ...real, adjudicate: mockAdjudicate }
})

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (s: unknown) => void) =>
    cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
  ),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  init: vi.fn(),
}))

function parkEnvelope(
  sessionId: string,
  envelope: IntentEnvelope,
  signal: string,
  ttlSeconds = 900,
): void {
  store.set(`test:defer:pending:${sessionId}`, {
    value: JSON.stringify({
      envelope: { ...envelope, actorPrincipal: envelope.actor.principal },
      signal,
      parkedAt: "2025-01-01T00:00:00.000Z",
    }),
    ttl: ttlSeconds,
  })
}

function paymentConfirmed(): PaymentStatusChangedEvent {
  return {
    orderId: "order_42",
    paymentId: "pay_42",
    previousStatus: "payment_pending",
    newStatus: "paid",
    method: "pix",
    version: 2,
    timestamp: "2025-01-01T00:05:00.000Z",
  }
}

describe("NEW-P0-X1 boot-window race", () => {
  beforeEach(() => {
    store.clear()
    vi.clearAllMocks()
    redisStub = makeRedisStub()
    mockGetAuditSinkEmit.mockResolvedValue(undefined)
  })

  it("does NOT mark a parked envelope as resumed when dispatcher is not wired (data-loss prevention)", async () => {
    const sessionId = "sess_boot_window"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_42", amountInCentavos: 100 },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "boot-window-nonce-1",
    })

    parkEnvelope(sessionId, envelope, "payment.confirmed")
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    // Simulate the boot-window: subscriber STARTS without dispatcher wiring.
    // Pre-fix this means the module-level _dispatcher remains null.
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(null) // ensure dispatcher is unset

    await startDeferResolverSubscriber()
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]

    // Deliver the PIX wire event during the boot-window.
    await callback(paymentConfirmed())

    // INVARIANT: when the dispatcher is null, the parked envelope MUST NOT
    // be marked durably resumed. Otherwise a retry can never recover.
    //
    // Pre-fix behavior: defer:resumed:{hash} is set + defer:pending:{sid}
    // is deleted, so the envelope is silently lost.
    //
    // Post-fix behavior: either the dispatcher is required to be present
    // before starting (so this scenario is impossible), or the resolver
    // refuses to commit when dispatcher is missing (envelope survives).
    const pendingStillPresent =
      store.get(`test:defer:pending:${sessionId}`) !== undefined
    const resumedKeys = [...store.keys()].filter((k) =>
      k.startsWith("test:defer:resumed:"),
    )

    // The fix prevents silent commit when there is no dispatcher.
    // Either pending is preserved OR the resumed marker is NOT set.
    expect(
      pendingStillPresent || resumedKeys.length === 0,
      "Boot-window race: parked envelope must not be silently committed without a dispatcher",
    ).toBe(true)
  })

  it("when dispatcher IS provided at startup, the envelope dispatches normally", async () => {
    const sessionId = "sess_with_dispatcher"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_42", amountInCentavos: 100 },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "with-dispatcher-nonce-1",
    })

    parkEnvelope(sessionId, envelope, "payment.confirmed")
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    // Post-fix: wire dispatcher BEFORE starting the subscriber.
    setResumeIntentDispatcher(dispatcher)
    await startDeferResolverSubscriber()

    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]
    await callback(paymentConfirmed())

    expect(dispatcher).toHaveBeenCalledOnce()
    setResumeIntentDispatcher(null)
  })
})
