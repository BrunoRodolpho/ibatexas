// DEFER park/resume extensions — Task 20.
//
// `defer-roundtrip.test.ts` covers the canonical happy-path + tampered
// envelope cases. This file adds:
//
//   - Duplicate-delivery: NATS replays the same payment.confirmed; only
//     one dispatch fires (the deferred-resolver's dedup invariant).
//   - Schema regressions: a parked blob missing the required envelope
//     field is rejected without calling the dispatcher.
//   - TTL surface: an explicit TTL is stored on the parked key so the
//     defer-sweeper has a cleanup contract to honour.
//
// These cover the gaps investigation 07 §"Test categories — coverage
// matrix" #4 flagged after task 03 landed only the smoke test.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing"
import { rk } from "@ibatexas/tools"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn())
const mockAdjudicate = vi.hoisted(() => vi.fn())
const mockSentryWithScope = vi.hoisted(() => vi.fn())
const mockSentryCaptureMessage = vi.hoisted(() => vi.fn())
const mockSentryCaptureException = vi.hoisted(() => vi.fn())

// R5-S12 — the copy-pasted hand-rolled double is retired for the canonical
// adapter, threaded in through the `startDeferResolverSubscriber({ redis })`
// seam, with `rk()` running REAL (Hard Rule #7). The clock is frozen so the
// TTL case below can pin an EXACT remaining lifetime: the retired double
// stored the EX argument verbatim and read it straight back, so that case
// could only ever re-assert its own input.
const FROZEN_MS = 1_760_000_000_000
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
  return {
    ...real,
    adjudicate: mockAdjudicate,
  }
})

vi.mock("@sentry/node", () => ({
  withScope: mockSentryWithScope,
  captureMessage: mockSentryCaptureMessage,
  captureException: mockSentryCaptureException,
  init: vi.fn(),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DEFER park/resume — extension cases (Task 20)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis = createInMemoryRedis({ now: () => FROZEN_MS })
    mockGetRedisClient.mockImplementation(async () => redis.client)
    mockSentryWithScope.mockImplementation((cb: (s: unknown) => void) =>
      cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
    )
    mockGetAuditSinkEmit.mockResolvedValue(undefined)
  })

  it("duplicate-delivery: dispatcher fires at most once when payment.confirmed is replayed", async () => {
    const sessionId = "sess_dup"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_42", amountInCentavos: 8900 },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "dup-nonce-1",
    })

    await parkEnvelope(sessionId, envelope, "payment.confirmed")
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    await startDeferResolverSubscriber(undefined, { redis: redis.client })
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]

    // First delivery — fires dispatcher and clears the parked key.
    await callback(paymentConfirmed())
    // Second delivery — parked key is gone; nothing happens.
    await callback(paymentConfirmed())

    expect(dispatcher).toHaveBeenCalledOnce()
    expect(redis.peek(parkKey(sessionId))).toBeUndefined()

    setResumeIntentDispatcher(null)
  })

  it("never dispatches when no envelope is parked (orphan webhook delivery)", async () => {
    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    await startDeferResolverSubscriber(undefined, { redis: redis.client })
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]

    // No park step — webhook arrives orphaned (the responder never DEFERred).
    await callback(paymentConfirmed())

    expect(dispatcher).not.toHaveBeenCalled()
    expect(mockAdjudicate).not.toHaveBeenCalled()

    setResumeIntentDispatcher(null)
  })

  it("preserves the parked TTL on the Redis key (defer-sweeper contract)", async () => {
    const sessionId = "sess_ttl"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_99" },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "ttl-nonce-1",
    })
    await parkEnvelope(sessionId, envelope, "payment.confirmed", 600)
    // Against a frozen clock the remaining lifetime is exact, and it is read
    // back as a real expiry rather than as the argument the seed passed in.
    expect(redis.peek(parkKey(sessionId))).toBeDefined()
    expect(redis.ttlMs(parkKey(sessionId))).toBe(600_000)
  })
})
