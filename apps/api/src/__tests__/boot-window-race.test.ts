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
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing"
import { rk } from "@ibatexas/tools"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn())
const mockAdjudicate = vi.hoisted(() => vi.fn())

// R5-S12 — the copy-pasted hand-rolled double is retired for the canonical
// adapter, threaded in through the `startDeferResolverSubscriber({ redis })`
// seam. `rk()` runs REAL (Hard Rule #7): the retired double was reached
// through a faked `rk` hardcoding a `test:` prefix, so every key this file
// asserted on was a test-local invention rather than production's.
let redis: InMemoryRedis

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
  publishNatsEvent: mockPublishNatsEvent,
}))

const mockGetRedisClient = vi.hoisted(() => vi.fn())
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>()
  return { ...real, getRedisClient: mockGetRedisClient }
})

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

async function parkEnvelope(
  sessionId: string,
  envelope: IntentEnvelope,
  signal: string,
  ttlSeconds = 900,
): Promise<void> {
  await redis.client.set(
    parkKey(sessionId),
    JSON.stringify({
      envelope: {
        ...envelope,
        actorPrincipal: envelope.actor.principal,
      },
      signal,
      parkedAt: "2025-01-01T00:00:00.000Z",
    }),
    { EX: ttlSeconds } as { EX: number },
  )
}

function parkKey(sessionId: string): string {
  return rk(`defer:pending:${sessionId}`)
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
    vi.clearAllMocks()
    redis = createInMemoryRedis()
    mockGetRedisClient.mockImplementation(async () => redis.client)
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

    await parkEnvelope(sessionId, envelope, "payment.confirmed")
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    // Simulate the boot-window: subscriber STARTS without dispatcher wiring.
    // Pre-fix this means the module-level _dispatcher remains null.
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(null) // ensure dispatcher is unset

    await startDeferResolverSubscriber(undefined, { redis: redis.client })
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
    const pendingStillPresent = redis.peek(parkKey(sessionId)) !== undefined
    const resumedKeys = redis
      .keys()
      .filter((k) => k.startsWith(rk("defer:resumed:")))

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

    await parkEnvelope(sessionId, envelope, "payment.confirmed")
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    // Post-fix: wire dispatcher BEFORE starting the subscriber.
    setResumeIntentDispatcher(dispatcher)
    await startDeferResolverSubscriber(undefined, { redis: redis.client })

    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]
    await callback(paymentConfirmed())

    expect(dispatcher).toHaveBeenCalledOnce()
    setResumeIntentDispatcher(null)
  })
})
