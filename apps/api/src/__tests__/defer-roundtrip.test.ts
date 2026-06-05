// End-to-end roundtrip: park an envelope (mimicking the responder
// DEFER branch in llm-responder.ts), publish payment.status_changed via
// the captured NATS callback, assert the dispatcher receives the same
// intentHash.
//
// This is the bypass-detection guard: a tampered parked envelope is
// also tested here — the dispatcher MUST NOT see a mutated payload.

import { describe, it, expect, vi, beforeEach } from "vitest"
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
function parkEnvelope(
  sessionId: string,
  envelope: IntentEnvelope,
  signal: string,
  ttlSeconds = 900,
): void {
  store.set(`test:defer:pending:${sessionId}`, {
    value: JSON.stringify({
      envelope: {
        ...envelope,
        actorPrincipal: envelope.actor.principal,
      },
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("defer roundtrip (park → wire event → dispatch)", () => {
  beforeEach(() => {
    store.clear()
    vi.clearAllMocks()
    redisStub = makeRedisStub()
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
    parkEnvelope(sessionId, envelope, "payment.confirmed")

    // 2) Kernel re-adjudicates to EXECUTE on resume.
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    // 3) Wire the dispatcher and subscriber.
    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    await startDeferResolverSubscriber()
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
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()

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
    parkEnvelope(sessionId, envelope, "payment.confirmed")
    // Tamper: re-write the blob with a mutated amount, keeping the
    // original intentHash. verifyParkedEnvelopeHash will detect the
    // mismatch when it re-derives.
    const key = `test:defer:pending:${sessionId}`
    const original = store.get(key)!
    store.set(key, {
      value: original.value.replace(
        '"amountInCentavos":100',
        '"amountInCentavos":99999',
      ),
      ttl: original.ttl,
    })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    await startDeferResolverSubscriber()
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]
    await callback(paymentConfirmed())

    expect(mockAdjudicate).not.toHaveBeenCalled()
    expect(dispatcher).not.toHaveBeenCalled()
    // The tampered key is deleted (so it doesn't keep tripping every sweep).
    expect(store.get(key)).toBeUndefined()

    setResumeIntentDispatcher(null)
  })
})
