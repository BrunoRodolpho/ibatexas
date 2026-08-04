// End-to-end roundtrip: park an envelope (mimicking the responder
// DEFER branch in llm-responder.ts), publish payment.status_changed via
// the captured NATS callback, assert the dispatcher receives the same
// intentHash.
//
// This is the bypass-detection guard: a tampered parked envelope is
// also tested here — the dispatcher MUST NOT see a mutated payload.

// R5-S12 — the hand-rolled Redis double is retired here. The keyspace is the
// canonical `createInMemoryRedis` adapter, threaded in through the
// `startDeferResolverSubscriber({ redis })` seam, and `rk()` runs REAL
// (Hard Rule #7) so the keys under assertion are the ones production writes —
// the retired stub was reached through a faked `rk` that hardcoded a `test:`
// prefix this package's env does not actually produce.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing"
import { rk } from "@ibatexas/tools"

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn())
const mockAdjudicate = vi.hoisted(() => vi.fn())
const mockSentryWithScope = vi.hoisted(() => vi.fn())
const mockSentryCaptureMessage = vi.hoisted(() => vi.fn())
const mockSentryCaptureException = vi.hoisted(() => vi.fn())
// Spy-delegate: forwards to the canonical adapter. It exists so this file can
// prove the seam carries the whole resume path — every case asserts it was
// never called, which is only true while the threading holds.
const mockGetRedisClient = vi.hoisted(() => vi.fn())

// The canonical adapter replaces a 60-line hand-rolled stub whose `lPush`
// returned a constant 1 without storing anything (so any DLQ write this path
// made was asserted into a void) and whose `scanIterator` was an eager
// generator over a plain Map.
let redis: InMemoryRedis

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
  publishNatsEvent: mockPublishNatsEvent,
}))

// Spread the REAL module so `rk()` is the real one; replace only the client
// resolver, with a spy-delegate that forwards to the canonical adapter.
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

/**
 * Simulate the responder's DEFER park (llm-responder.ts:384-406) but with
 * the modern verification fields so verifyParkedEnvelopeHash succeeds.
 */
async function parkEnvelope(
  sessionId: string,
  envelope: IntentEnvelope,
  signal: string,
  ttlSeconds = 900,
): Promise<void> {
  // Seeded through the adapter's own SET — the same command and options the
  // responder parks with — rather than by reaching into a backing Map.
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

describe("defer roundtrip (park → wire event → dispatch)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis = createInMemoryRedis()
    mockGetRedisClient.mockImplementation(async () => redis.client)
    mockSentryWithScope.mockImplementation((cb: (s: unknown) => void) =>
      cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
    )
    mockGetAuditSinkEmit.mockResolvedValue(undefined)
  })

  it("dispatches the resumed envelope with the SAME intentHash that was parked", async () => {
    const sessionId = "sess_roundtrip"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_42", amountInCentavos: 8900 },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "roundtrip-nonce-1",
    })

    // 1) Park (simulating the responder).
    await parkEnvelope(sessionId, envelope, "payment.confirmed")

    // 2) Kernel re-adjudicates to EXECUTE on resume.
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    // 3) Wire the dispatcher and subscriber.
    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    await startDeferResolverSubscriber(undefined, { redis: redis.client })
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]

    // 4) Deliver the wire event.
    await callback(paymentConfirmed())

    // 5) Assert dispatcher saw the original intentHash.
    expect(dispatcher).toHaveBeenCalledOnce()
    const [resumedIntent] = dispatcher.mock.calls[0] as unknown as [
      {
        envelope: IntentEnvelope
        sessionId: string
        originalIntentHash: string
      },
    ]
    expect(resumedIntent.envelope.intentHash).toBe(envelope.intentHash)
    expect(resumedIntent.sessionId).toBe(sessionId)
    expect(resumedIntent.originalIntentHash).toBe(envelope.intentHash)

    // 6) Parked key is consumed.
    expect(redis.peek(parkKey(sessionId))).toBeUndefined()

    // 7) The whole resume path ran off the THREADED client — the singleton
    // resolver was never reached. This is what makes the seam load-bearing
    // here rather than decorative: drop the `{ redis }` argument and this
    // is the assertion that reds.
    expect(mockGetRedisClient).not.toHaveBeenCalled()

    setResumeIntentDispatcher(null)
  })

  it("does NOT dispatch a parked envelope whose payload was mutated after park", async () => {
    const sessionId = "sess_tamper_e2e"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_42", amountInCentavos: 100 },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "tamper-nonce-1",
    })

    // Park with the legitimate envelope.
    await parkEnvelope(sessionId, envelope, "payment.confirmed")
    // Tamper: re-write the blob with a mutated amount, keeping the
    // original intentHash. verifyParkedEnvelopeHash will detect the
    // mismatch when it re-derives.
    const key = parkKey(sessionId)
    const original = redis.peek(key)!
    await redis.client.set(
      key,
      original.replace('"amountInCentavos":100', '"amountInCentavos":99999'),
    )

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    await startDeferResolverSubscriber(undefined, { redis: redis.client })
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]
    await callback(paymentConfirmed())

    expect(mockAdjudicate).not.toHaveBeenCalled()
    expect(dispatcher).not.toHaveBeenCalled()
    // The tampered key is deleted (so it doesn't keep tripping every sweep).
    expect(redis.peek(key)).toBeUndefined()

    // The ONE residual singleton resolution on this branch is the DLQ write:
    // `subscribers/dlq.ts` is outside the defer-resolver family and was not
    // threaded by R5-S12, so `pushToDlq` still resolves the client itself.
    // Measured, not assumed — the happy-path case above reaches ZERO. The
    // retired stub could not have shown this: its `lPush` returned a constant
    // 1 and stored nothing, so the DLQ write was asserted into a void.
    expect(mockGetRedisClient).toHaveBeenCalledTimes(1)
    const dlqKeys = redis.keys().filter((k) => k.includes("dlq:"))
    expect(dlqKeys).toHaveLength(1)

    setResumeIntentDispatcher(null)
  })
})
