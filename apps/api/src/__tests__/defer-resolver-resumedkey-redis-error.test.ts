// P1-D-VERIFY — defer-resolver:423 still uses `.catch(() => null)`.
//
// The deep audit (05-hidden-bugs.md #4) flagged that the W2 P1-D remediation
// claimed to remove every `.catch(() => null)` in favour of `robustRedisGet`,
// but the resumedKey lookup at `defer-resolver.ts:423` still had the buggy
// pattern. A transient Redis IOError on that line collapses to `null`, which
// the code interprets as "no prior resume" — and a duplicate dispatch fires.
//
// This test:
//   1. Parks an envelope in the in-memory Redis stub.
//   2. Configures the stub so `get(resumedKey)` THROWS (Redis IOError).
//   3. Triggers resolveDeferredSession via the wire callback.
//   4. Asserts:
//      - `robustRedisGet`'s retry loop runs (3 attempts visible on the
//        spy).
//      - After retries exhaust, the result is `transient_error` (not
//        `re_adjudicated`).
//      - `pushToDlq` was called with `intent.defer.resume`.

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

// Per-key throw spec. If `throwOnGet` returns true for a key, that get()
// call throws. We use a function so the test can vary behavior per attempt
// (e.g. throw on first 3 attempts, succeed on 4th — to verify retry).
let throwOnGet: (key: string, attempt: number) => boolean = () => false
const getAttempts = new Map<string, number>()
// Track every get() call site so we can assert retries fired.
const getCallLog: { key: string; threw: boolean }[] = []

function resetTestState(): void {
  getAttempts.clear()
  getCallLog.length = 0
  throwOnGet = () => false
}

let redis: InMemoryRedis

/**
 * R5-S12 — the fault injector is now a SPY-DELEGATE over the canonical adapter
 * rather than a hand-rolled keyspace. It decides whether THIS `get` should
 * throw, records the attempt, and otherwise forwards to the adapter's real
 * `get`. Every other command goes straight through untouched, so the retry
 * path is exercised against real SET/DEL/INCR/SCAN semantics instead of a
 * Map the test also wrote.
 */
function withGetFaults(client: InMemoryRedis["client"]): InMemoryRedis["client"] {
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== "get") return Reflect.get(target, prop) as unknown
      return async (key: string): Promise<string | null> => {
        const attempt = (getAttempts.get(key) ?? 0) + 1
        getAttempts.set(key, attempt)
        const willThrow = throwOnGet(key, attempt)
        getCallLog.push({ key, threw: willThrow })
        if (willThrow) {
          throw new Error(`redis IOError (simulated, attempt=${attempt})`)
        }
        return (
          target as unknown as { get(k: string): Promise<string | null> }
        ).get(key)
      }
    },
  }) as InMemoryRedis["client"]
}
const pushToDlqSpy = vi.hoisted(() => vi.fn(async () => undefined))

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

vi.mock("../subscribers/dlq.js", () => ({
  pushToDlq: pushToDlqSpy,
}))

async function parkEnvelope(
  sessionId: string,
  envelope: IntentEnvelope,
  signal: string,
  ttlSeconds = 900,
): Promise<void> {
  await redis.client.set(
    rk(`defer:pending:${sessionId}`),
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

function paymentConfirmed(): PaymentStatusChangedEvent {
  return {
    orderId: "order_p1d",
    paymentId: "pay_p1d",
    previousStatus: "payment_pending",
    newStatus: "paid",
    method: "pix",
    version: 2,
    timestamp: "2025-01-01T00:05:00.000Z",
  }
}

describe("P1-D-VERIFY — defer-resolver resumedKey GET is robust to Redis IOError", () => {
  beforeEach(() => {
    resetTestState()
    vi.clearAllMocks()
    redis = createInMemoryRedis()
    mockGetRedisClient.mockImplementation(async () => redis.client)
    mockSentryWithScope.mockImplementation((cb: (s: unknown) => void) =>
      cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
    )
    mockGetAuditSinkEmit.mockResolvedValue(undefined)
  })

  it("redis.get on resumedKey throws on all attempts → retries fire, then DLQ + transient_error", async () => {
    const sessionId = "sess_resumedkey_iowerror"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_p1d", amountInCentavos: 4500 },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "p1d-nonce-1",
    })

    await parkEnvelope(sessionId, envelope, "payment.confirmed")

    // Configure the stub: any GET against a key containing "defer:resumed:"
    // throws — that's the line we're verifying.
    throwOnGet = (key, _attempt) => key.includes("defer:resumed:")

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)
    await startDeferResolverSubscriber(undefined, {
      redis: withGetFaults(redis.client),
    })
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]

    await callback(paymentConfirmed())

    // ── Assertion 1: retries fired (3 attempts visible) ──────────────────
    const resumedKeyGetCalls = getCallLog.filter((c) =>
      c.key.includes("defer:resumed:"),
    )
    expect(resumedKeyGetCalls.length).toBeGreaterThanOrEqual(3)
    // All of them threw.
    expect(resumedKeyGetCalls.every((c) => c.threw)).toBe(true)

    // ── Assertion 2: dispatcher was NOT called (transient error path) ────
    // Pre-fix: the .catch(()=>null) collapsed the throw to "no resume yet"
    // and the dispatcher would have fired a duplicate dispatch.
    expect(dispatcher).not.toHaveBeenCalled()

    // ── Assertion 3: DLQ was called ──────────────────────────────────────
    expect(pushToDlqSpy).toHaveBeenCalled()
    const dlqCall = pushToDlqSpy.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      unknown,
    ]
    expect(dlqCall[0]).toBe("intent.defer.resume")
    expect(dlqCall[1].reason).toMatch(/redis|resumed|get/i)
  })

  it("redis.get throws once then succeeds → retry succeeds, normal resume path runs", async () => {
    const sessionId = "sess_resumedkey_transient"
    const envelope = buildEnvelope({
      kind: "order.confirm",
      payload: { orderId: "order_p1d", amountInCentavos: 4500 },
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: "p1d-nonce-2",
    })

    await parkEnvelope(sessionId, envelope, "payment.confirmed")

    // Throw on attempt 1, succeed afterwards. The retry should recover.
    throwOnGet = (key, attempt) =>
      key.includes("defer:resumed:") && attempt === 1

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../subscribers/defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)
    await startDeferResolverSubscriber(undefined, {
      redis: withGetFaults(redis.client),
    })
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
      string,
      (payload: unknown) => Promise<void>,
    ]

    await callback(paymentConfirmed())

    // Dispatcher should have been called — first GET threw, retry recovered.
    expect(dispatcher).toHaveBeenCalledOnce()
    // No DLQ entry on transient recovery.
    expect(pushToDlqSpy).not.toHaveBeenCalled()
  })
})
