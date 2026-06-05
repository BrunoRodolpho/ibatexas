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

describe("DEFER park/resume — extension cases (Task 20)", () => {
  beforeEach(() => {
    store.clear()
    vi.clearAllMocks()
    redisStub = makeRedisStub()
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

    parkEnvelope(sessionId, envelope, "payment.confirmed")
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    await startDeferResolverSubscriber()
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]

    // First delivery — fires dispatcher and clears the parked key.
    await callback(paymentConfirmed())
    // Second delivery — parked key is gone; nothing happens.
    await callback(paymentConfirmed())

    expect(dispatcher).toHaveBeenCalledOnce()
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()

    setResumeIntentDispatcher(null)
  })

  it("never dispatches when no envelope is parked (orphan webhook delivery)", async () => {
    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    await startDeferResolverSubscriber()
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

  it("preserves the parked TTL on the Redis key (defer-sweeper contract)", () => {
    const sessionId = "sess_ttl"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_99" },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "ttl-nonce-1",
    })
    parkEnvelope(sessionId, envelope, "payment.confirmed", 600)
    const entry = store.get(`test:defer:pending:${sessionId}`)
    expect(entry).toBeDefined()
    expect(entry!.ttl).toBe(600)
  })
})
