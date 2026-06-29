// Unit tests for the defer-resolver subscriber — task 03.
//
// What's under test:
//   1. resumeDeferredIntent (the IbateXas adapter) does NOT re-execute by
//      itself — that's the runtime's contract — but the higher-level
//      resolveDeferredSession() does. We focus on resolveDeferredSession.
//   2. The full NATS event path via startDeferResolverSubscriber: capture
//      the callback, drive it, assert SCAN + per-key behaviour.
//
// External dependencies are mocked at the module boundary:
//   - @ibatexas/nats-client (subscribe + publish)
//   - @ibatexas/tools (getRedisClient + rk are mocked with a tiny
//     in-memory Redis stub that supports get/set/del/ttl/scanIterator/incr)
//   - @ibatexas/llm-provider (orderPolicyBundle, getAuditSink, OrderContext type)
//   - @sentry/node (DLQ side-effect)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn())
const mockAdjudicate = vi.hoisted(() => vi.fn())
const mockSentryWithScope = vi.hoisted(() => vi.fn())
const mockSentryCaptureMessage = vi.hoisted(() => vi.fn())
const mockSentryCaptureException = vi.hoisted(() => vi.fn())

// ── In-memory Redis stub ───────────────────────────────────────────────────

interface StubEntry {
  value: string
  ttl: number // seconds; -1 = no expire; -2 = missing
}
const store = new Map<string, StubEntry>()

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
      const had = store.delete(key)
      return had ? 1 : 0
    },
    async ttl(key: string): Promise<number> {
      const e = store.get(key)
      if (!e) return -2
      return e.ttl
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
        for (const k of keys) {
          yield k
        }
      })()
    },
    async lPush(key: string, value: string): Promise<number> {
      const e = store.get(key)
      // Track DLQ list pushes by appending to a comma-joined value. The
      // tests only need to assert presence and count, not LRANGE semantics.
      const next = e ? `${e.value}\n${value}` : value
      store.set(key, { value: next, ttl: e?.ttl ?? -1 })
      return 1
    },
    // WS5: implement the Lua compare-and-delete used by
    // `releaseDeferResumingLock` (audit-2026-05-25 I7) and the NX
    // placeholder release in `park-nx.ts` (I8). The only scripts passed are
    // GET-equals-then-DEL; we emulate that semantics generically (release the
    // key iff its stored value equals arguments[0]). Pre-WS5 this stub lacked
    // `eval`, so the Lua release threw (swallowed) and the
    // `defer:resuming:*` marker was never cleared — the marker-cleanup
    // assertions only surfaced once the audit-sink mock was repointed so the
    // tests could run past the earlier audit assertion.
    async eval(
      _script: string,
      opts: { keys: string[]; arguments: string[] },
    ): Promise<number> {
      const key = opts.keys[0]!
      const expected = opts.arguments[0]
      const e = store.get(key)
      if (e && e.value === expected) {
        store.delete(key)
        return 1
      }
      return 0
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

// WS5 (claustrum-on-dev): the SUT (`defer-resolver.ts`) reads `getAuditSink`
// from `@ibatexas/audit-sink` and `orderPolicyBundle` from `@ibatexas/pack-orders`
// — NOT from `@ibatexas/llm-provider` (it no longer imports llm-provider at all).
// The audit spy must therefore be installed on `@ibatexas/audit-sink`; the real
// `getAuditSink()` is fail-closed (throws before boot wiring), so without this
// mock the resolver's audit-emit path would never reach the spy. The
// `orderPolicyBundle` is inert here because `adjudicate` is mocked below.
vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: () => ({
    emit: mockGetAuditSinkEmit,
  }),
}))

vi.mock("@ibatexas/pack-orders", () => ({
  ordersPolicyBundle: {},
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

function makeLogger(): import("fastify").FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
    silent: vi.fn(),
  } as unknown as import("fastify").FastifyBaseLogger
}

/**
 * Build a parked-envelope blob with the modern v0.5 hash-verification fields
 * (actorPrincipal, version, nonce, taint flattened on the envelope). The
 * runtime can verify this byte-equally against its derived hash.
 */
function buildVerifiableParkedBlob(opts?: {
  sessionId?: string
  signal?: string
  payload?: unknown
}): { envelope: IntentEnvelope; parkedBlob: string; parkedAt: string } {
  const sessionId = opts?.sessionId ?? "sess_abc"
  const envelope = buildEnvelope({
    kind: "order.confirm",
    payload: opts?.payload ?? { orderId: "order_42" },
    actor: { principal: "user", sessionId },
    taint: "UNTRUSTED",
    nonce: "test-nonce-1",
  })
  const parkedAt = "2025-01-01T00:00:00.000Z"
  // The parked blob carries flattened verification fields so
  // verifyParkedEnvelopeHash succeeds.
  const parkedBlob = JSON.stringify({
    envelope: {
      ...envelope,
      // Re-derive the verification fields the runtime expects.
      actorPrincipal: envelope.actor.principal,
    },
    signal: opts?.signal ?? "payment.confirmed",
    parkedAt,
  })
  return { envelope, parkedBlob, parkedAt }
}

function paymentConfirmedEvent(
  overrides: Partial<PaymentStatusChangedEvent> = {},
): PaymentStatusChangedEvent {
  return {
    orderId: "order_42",
    paymentId: "pay_42",
    previousStatus: "payment_pending",
    newStatus: "paid",
    method: "pix",
    version: 2,
    timestamp: "2025-01-01T00:05:00.000Z",
    ...overrides,
  }
}

async function getRegisteredCallback(
  startFn: (log?: import("fastify").FastifyBaseLogger) => Promise<void>,
  log?: import("fastify").FastifyBaseLogger,
): Promise<(payload: unknown) => Promise<void>> {
  mockSubscribeNatsEvent.mockClear()
  await startFn(log)
  expect(mockSubscribeNatsEvent).toHaveBeenCalledOnce()
  const call = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
    string,
    (payload: unknown) => Promise<void>,
  ]
  expect(call[0]).toBe("payment.status_changed")
  return call[1]
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("defer-resolver subscriber", () => {
  beforeEach(() => {
    store.clear()
    vi.clearAllMocks()
    redisStub = makeRedisStub()
    mockSentryWithScope.mockImplementation((cb: (s: unknown) => void) =>
      cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
    )
    mockGetAuditSinkEmit.mockResolvedValue(undefined)
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  // ── 1. Happy path: resumes parked envelope and dispatches ───────────────

  it("re-adjudicates the parked envelope and dispatches when decision is EXECUTE", async () => {
    const sessionId = "sess_happy"
    const { envelope, parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(
      startDeferResolverSubscriber,
      makeLogger(),
    )
    await callback(paymentConfirmedEvent())

    // adjudicate() was invoked with the parked envelope's IntentEnvelope.
    expect(mockAdjudicate).toHaveBeenCalledOnce()
    const [adjudicatedEnvelope] = mockAdjudicate.mock.calls[0] as unknown as [
      IntentEnvelope,
    ]
    expect(adjudicatedEnvelope.intentHash).toBe(envelope.intentHash)
    expect(adjudicatedEnvelope.kind).toBe("order.confirm")

    // Dispatcher fired with the same intentHash.
    expect(dispatcher).toHaveBeenCalledOnce()
    const [resumedIntent] = dispatcher.mock.calls[0] as unknown as [
      { envelope: IntentEnvelope; sessionId: string; originalIntentHash: string },
    ]
    expect(resumedIntent.envelope.intentHash).toBe(envelope.intentHash)
    expect(resumedIntent.sessionId).toBe(sessionId)
    expect(resumedIntent.originalIntentHash).toBe(envelope.intentHash)

    // Parked key was consumed (resumeDeferredIntent deletes it on success).
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()

    // Dedup ledger key was written.
    const ledgerKeys = [...store.keys()].filter((k) =>
      k.startsWith("test:defer:resumed:"),
    )
    expect(ledgerKeys).toHaveLength(1)

    // Audit record was emitted.
    expect(mockGetAuditSinkEmit).toHaveBeenCalled()

    setResumeIntentDispatcher(null)
  })

  // ── 2. Duplicate webhook delivery: dispatcher fires only once ───────────

  it("does not re-execute when the same wire event is delivered twice", async () => {
    const sessionId = "sess_dup"
    const { parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)

    // First delivery resumes + dispatches.
    await callback(paymentConfirmedEvent())
    expect(dispatcher).toHaveBeenCalledTimes(1)

    // Re-park (simulate a stale duplicate that somehow gets back into the
    // keyspace) and deliver the event a second time. The resume-dedup
    // ledger should suppress the re-execute.
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })
    await callback(paymentConfirmedEvent())

    expect(dispatcher).toHaveBeenCalledTimes(1)
    // The duplicate path does NOT delete the parked key.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()

    setResumeIntentDispatcher(null)
  })

  // ── 3. Tampered envelope: refuses + DLQ + no dispatch ────────────────────

  it("refuses to resume a tampered parked envelope and pushes to DLQ", async () => {
    const sessionId = "sess_tamper"
    const { parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    // Mutate the JSON by changing the payload, preserving the stored
    // intentHash. The runtime's verifyParkedEnvelopeHash will re-derive
    // and detect the mismatch.
    const tampered = parkedBlob.replace(
      '"orderId":"order_42"',
      '"orderId":"order_HACK"',
    )
    store.set(`test:defer:pending:${sessionId}`, { value: tampered, ttl: 800 })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(
      startDeferResolverSubscriber,
      makeLogger(),
    )
    await callback(paymentConfirmedEvent())

    // adjudicate() must NOT be called — verification fails first.
    expect(mockAdjudicate).not.toHaveBeenCalled()
    // Dispatcher must NOT be called.
    expect(dispatcher).not.toHaveBeenCalled()
    // Parked key was deleted to prevent re-tripping on every sweep.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()
    // DLQ side: Sentry captureMessage fired (dlq.ts behaviour) and we
    // wrote to a dlq:* list.
    const dlqKeys = [...store.keys()].filter((k) => k.includes("dlq:"))
    expect(dlqKeys.length).toBeGreaterThanOrEqual(1)

    setResumeIntentDispatcher(null)
  })

  // ── 3b. Unverifiable envelope (missing fields): refuses + DLQ + no dispatch
  //
  // W8-Q2: pre-W8-Q2 the resolver would log a warn and silently proceed
  // for legacy v0.1 blobs (verifyHash:"warn" semantics on the framework side).
  // The new contract: ANY blob the framework reports as `verified: null,
  // reason: "missing_fields"` is refused at the adopter boundary — the only
  // way to land here in W8-Q2+ is a pre-fix legacy blob OR field-stripping
  // by a malicious writer. Both warrant DLQ + delete + no dispatch.

  it("refuses to resume a parked envelope missing hash-verification fields (W8-Q2 fail-loud)", async () => {
    const sessionId = "sess_missing_fields"
    // Build a "legacy" parked blob: envelope has intentHash, kind, actor,
    // payload, signal, parkedAt — but NO version/nonce/taint/actorPrincipal
    // at the top level. The framework verifier would have returned
    // {verified: null, reason: "missing_fields"}.
    const legacyParkedBlob = JSON.stringify({
      envelope: {
        intentHash: "deadbeef".padEnd(64, "0"),
        kind: "order.confirm",
        actor: { sessionId },
        payload: { orderId: "order_42" },
        // NO version, nonce, taint, actorPrincipal at top level.
      },
      signal: "payment.confirmed",
      parkedAt: "2025-01-01T00:00:00.000Z",
    })
    store.set(`test:defer:pending:${sessionId}`, {
      value: legacyParkedBlob,
      ttl: 800,
    })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(
      startDeferResolverSubscriber,
      makeLogger(),
    )
    await callback(paymentConfirmedEvent())

    // adjudicate() must NOT be called — fail-loud refuses before dispatch.
    expect(mockAdjudicate).not.toHaveBeenCalled()
    // Dispatcher must NOT be called.
    expect(dispatcher).not.toHaveBeenCalled()
    // Parked key was deleted to prevent re-tripping on every sweep.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()
    // DLQ side: we wrote to a dlq:* list.
    const dlqKeys = [...store.keys()].filter((k) => k.includes("dlq:"))
    expect(dlqKeys.length).toBeGreaterThanOrEqual(1)

    setResumeIntentDispatcher(null)
  })

  // ── 4. Cycle cap: 4th resume is refused ──────────────────────────────────

  it("respects the runtime's resume cycle cap (DEFAULT_MAX_RESUME_CYCLES=3)", async () => {
    const sessionId = "sess_cycle"
    const { envelope, parkedBlob } = buildVerifiableParkedBlob({ sessionId })

    // Pre-load the cycle counter to 3 (the cap). The 4th resume bumps
    // it to 4 → cycle_cap_exceeded.
    store.set(`test:defer:cycle:${envelope.intentHash}`, {
      value: "3",
      ttl: 1_209_600,
    })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)
    await callback(paymentConfirmedEvent())

    // adjudicate + dispatcher both skipped because resumeDeferredIntent
    // returned {resumed:false, reason:"cycle_cap_exceeded"}.
    expect(mockAdjudicate).not.toHaveBeenCalled()
    expect(dispatcher).not.toHaveBeenCalled()

    // Parked key stays (we did NOT consume it — it'll TTL out).
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()

    setResumeIntentDispatcher(null)
  })

  // ── 5. Non-settled wire status: no-op ───────────────────────────────────

  it("skips entirely when the wire status is not in SETTLED_WIRE_STATUSES", async () => {
    const sessionId = "sess_skipstatus"
    const { parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)
    await callback(paymentConfirmedEvent({ newStatus: "payment_pending" }))

    expect(mockAdjudicate).not.toHaveBeenCalled()
    expect(dispatcher).not.toHaveBeenCalled()
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()

    setResumeIntentDispatcher(null)
  })

  // ── 6. No parked envelopes: SCAN returns empty, no adjudication ─────────

  it("does nothing when SCAN finds no parked envelopes", async () => {
    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)
    await callback(paymentConfirmedEvent())

    expect(mockAdjudicate).not.toHaveBeenCalled()
    expect(dispatcher).not.toHaveBeenCalled()

    setResumeIntentDispatcher(null)
  })

  // ── 7. REFUSE decision on resume: no dispatch, audit still emitted ──────

  it("emits audit but does not dispatch when re-adjudicate returns REFUSE", async () => {
    const sessionId = "sess_refuse"
    const { parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: { userFacing: "não posso", code: "x", kind: "y" },
      basis: [],
    })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)
    await callback(paymentConfirmedEvent())

    expect(mockAdjudicate).toHaveBeenCalledOnce()
    expect(dispatcher).not.toHaveBeenCalled()
    expect(mockGetAuditSinkEmit).toHaveBeenCalled()
    // Parked key still consumed (resumeDeferredIntent deletes it on success).
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()

    setResumeIntentDispatcher(null)
  })

  // ── P0-8: Two-phase commit (resuming marker + commit ordering) ───────────

  it("[P0-8] writes a defer:resuming marker BEFORE dispatch and deletes it AFTER success", async () => {
    const sessionId = "sess_two_phase"
    const { envelope, parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    // Observe the resuming marker presence at dispatch time. The dispatcher
    // is invoked AFTER the marker is set, so the assertion checks the
    // intermediate state DURING dispatch — proving the two-phase ordering.
    const dispatcher = vi.fn(async () => {
      const resumingKeys = [...store.keys()].filter((k) =>
        k.startsWith("test:defer:resuming:"),
      )
      expect(resumingKeys).toHaveLength(1)
      // Long-term dedup ledger NOT yet written — commit happens after this.
      const resumedKeys = [...store.keys()].filter((k) =>
        k.startsWith("test:defer:resumed:"),
      )
      expect(resumedKeys).toHaveLength(0)
    })
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)
    await callback(paymentConfirmedEvent())

    expect(dispatcher).toHaveBeenCalledOnce()
    // After commit: resuming marker cleared, resumed ledger written.
    const resumingKeysPost = [...store.keys()].filter((k) =>
      k.startsWith("test:defer:resuming:"),
    )
    expect(resumingKeysPost).toHaveLength(0)
    const resumedKeysPost = [...store.keys()].filter((k) =>
      k.startsWith("test:defer:resumed:"),
    )
    expect(resumedKeysPost).toHaveLength(1)
    // Parked key was consumed (commit deletes it).
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()
    // Verify intentHash is consistent.
    expect(envelope.intentHash).toBeTruthy()

    setResumeIntentDispatcher(null)
  })

  it("[P0-8] dispatch failure leaves the parked key INTACT for retry + clears resuming marker", async () => {
    const sessionId = "sess_dispatch_fail"
    const { envelope, parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => {
      throw new Error("upstream service down")
    })
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(
      startDeferResolverSubscriber,
      makeLogger(),
    )
    await callback(paymentConfirmedEvent())

    expect(dispatcher).toHaveBeenCalledOnce()
    // CRITICAL: parked key MUST remain so retry can re-enter the flow.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()
    // Resuming marker cleared so next attempt isn't blocked.
    const resumingKeys = [...store.keys()].filter((k) =>
      k.startsWith("test:defer:resuming:"),
    )
    expect(resumingKeys).toHaveLength(0)
    // Long-term dedup ledger NOT written — dispatch failed, this resume
    // never durably committed.
    const resumedKeys = [...store.keys()].filter((k) =>
      k.startsWith("test:defer:resumed:"),
    )
    expect(resumedKeys).toHaveLength(0)
    // intentHash sanity check.
    expect(envelope.intentHash).toBeTruthy()

    setResumeIntentDispatcher(null)
  })

  it("[P0-8] concurrent NATS deliveries: second delivery sees resuming marker and short-circuits", async () => {
    const sessionId = "sess_concurrent"
    const { envelope, parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    // Hold the dispatcher so we can run a second callback in parallel.
    let resolveDispatch: () => void = () => undefined
    const dispatchHeld = new Promise<void>((resolve) => {
      resolveDispatch = resolve
    })
    const dispatcher = vi.fn(async () => {
      await dispatchHeld
    })
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)

    // Fire first delivery — dispatcher is now waiting.
    const first = callback(paymentConfirmedEvent())

    // Wait a tick so first delivery has installed the resuming marker.
    await new Promise((r) => setTimeout(r, 0))
    const resumingMid = [...store.keys()].filter((k) =>
      k.startsWith("test:defer:resuming:"),
    )
    expect(resumingMid).toHaveLength(1)

    // Fire second delivery DURING the first dispatcher's wait. It should
    // see the resuming marker and short-circuit as duplicate_suppressed.
    await callback(paymentConfirmedEvent())
    // Only ONE dispatcher call so far (the first; second was suppressed).
    expect(dispatcher).toHaveBeenCalledTimes(1)

    // Release the first dispatcher — it commits the resume.
    resolveDispatch()
    await first

    // Final state: parked deleted, resumed ledger written, resuming cleared.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()
    expect(envelope.intentHash).toBeTruthy()

    setResumeIntentDispatcher(null)
  })

  it("[P0-8] simulated restart mid-resume: orphan resuming marker, retry succeeds via cleared marker", async () => {
    // Simulate the post-crash state: pending key is INTACT (because P0-8
    // leaves it until commit), and a stale resuming marker exists from the
    // crashed worker. A live worker should NOT find the marker on retry
    // because the marker's TTL has expired (or a sweeper cleaned it up).
    const sessionId = "sess_restart"
    const { envelope, parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })
    // Simulate that the crashed worker's resuming marker has expired
    // (i.e., it's no longer in the store). The retry flow should:
    //   1. Find the still-parked envelope
    //   2. Re-claim the resuming slot (no contention)
    //   3. Re-dispatch and commit

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)
    await callback(paymentConfirmedEvent())

    expect(dispatcher).toHaveBeenCalledOnce()
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()
    expect(envelope.intentHash).toBeTruthy()
    const resumedKeys = [...store.keys()].filter((k) =>
      k.startsWith("test:defer:resumed:"),
    )
    expect(resumedKeys).toHaveLength(1)

    setResumeIntentDispatcher(null)
  })

  // ── P1-D: Distinguish transient Redis errors from null ──────────────────

  it("[P1-D] transient Redis error on GET is retried then DLQ'd; result is transient_error (NOT no_park)", async () => {
    const sessionId = "sess_redis_err"
    const { resolveDeferredSession } = await import("../defer-resolver.js")

    // Override the get method to throw — covers all retry attempts.
    let getCalls = 0
    const originalGet = redisStub.get.bind(redisStub)
    redisStub.get = vi.fn(async (_key: string) => {
      getCalls++
      throw new Error("ECONNRESET — Redis connection lost")
    }) as typeof redisStub.get

    const result = await resolveDeferredSession({
      sessionId,
      signal: "payment.confirmed",
      event: paymentConfirmedEvent(),
      log: makeLogger(),
    })

    // Should NOT be no_park — that would silently drop the PIX confirmation.
    expect(result.kind).toBe("transient_error")
    if (result.kind === "transient_error") {
      expect(result.reason).toMatch(/redis_get_failed/i)
    }
    // 3 retry attempts.
    expect(getCalls).toBe(3)
    // DLQ side: Sentry captureMessage fired + dlq:* list was written.
    const dlqKeys = [...store.keys()].filter((k) => k.includes("dlq:"))
    expect(dlqKeys.length).toBeGreaterThanOrEqual(1)

    redisStub.get = originalGet
  })

  it("[P1-D] real null (no parked envelope) still returns no_park (not transient_error)", async () => {
    const sessionId = "sess_real_null"
    const { resolveDeferredSession } = await import("../defer-resolver.js")

    // No park exists. redisStub.get returns null cleanly.
    const result = await resolveDeferredSession({
      sessionId,
      signal: "payment.confirmed",
      event: paymentConfirmedEvent(),
      log: makeLogger(),
    })

    expect(result.kind).toBe("no_park")
    // No DLQ on a legitimate "no park found" — only on transient errors.
    const dlqKeys = [...store.keys()].filter((k) => k.includes("dlq:"))
    expect(dlqKeys).toHaveLength(0)
  })

  // ── P1-5 — supersedes wired on resume audit record ───────────────────────

  it("[P1-5] resume audit record carries supersedes pointing at the original parked intent's hash", async () => {
    const sessionId = "sess_supersedes"
    const { envelope, parkedBlob, parkedAt } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, startDeferResolverSubscriber } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const callback = await getRegisteredCallback(startDeferResolverSubscriber)
    await callback(paymentConfirmedEvent())

    expect(mockGetAuditSinkEmit).toHaveBeenCalledOnce()
    const record = (mockGetAuditSinkEmit.mock.calls as unknown as Array<
      [unknown]
    >)[0]![0] as {
      supersedes?: {
        predecessorIntentHash: string
        predecessorAt: string
        reason: string
      }
      envelope: { intentHash: string }
    }

    // The new (resume) record's envelope hash equals the parked one (we
    // re-adjudicated the same envelope); supersedes points back to that
    // same predecessor hash and the original parkedAt timestamp.
    expect(record.envelope.intentHash).toBe(envelope.intentHash)
    expect(record.supersedes).toBeTruthy()
    expect(record.supersedes!.predecessorIntentHash).toBe(envelope.intentHash)
    expect(record.supersedes!.predecessorAt).toBe(parkedAt)
    expect(record.supersedes!.reason).toBe("defer_resumed")

    setResumeIntentDispatcher(null)
  })

  // ── E2 (Fix-b) — post-SETNX parkKey re-check ────────────────────────────
  //
  // Race window: resolver GETs parkKey (caching the blob in-memory), then
  // the sweeper races ahead — SETNX-acquires the mutex, publishes
  // intent.defer.timeout, DELs parkKey, DELs the mutex. The resolver now
  // SETNX-acquires the just-released mutex. Without the post-SETNX
  // re-check, the resolver would dispatch the cached in-memory blob, double-
  // executing the destructive op. With Fix-b, the resolver re-checks parkKey
  // under its mutex and exits cleanly when the key is gone.
  it("[E2-fix-b] post-SETNX parkKey re-check: when parkKey vanishes after the resolver's first GET, resolver releases mutex and emits defer.resume.skipped", async () => {
    const sessionId = "sess_e2_fix_b"
    const { envelope, parkedBlob, parkedAt } = buildVerifiableParkedBlob({
      sessionId,
    })
    store.set(`test:defer:pending:${sessionId}`, {
      value: parkedBlob,
      ttl: 800,
    })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    // Stub redis.get to simulate the race: the FIRST call for the parkKey
    // returns the blob (resolver caches it in-memory), and ALL subsequent
    // calls for the parkKey return null (sweeper has DEL'd it). All other
    // keys (resumed ledger, etc.) pass through to the underlying store.
    const originalGet = redisStub.get.bind(redisStub)
    let parkKeyReads = 0
    const parkKey = `test:defer:pending:${sessionId}`
    redisStub.get = vi.fn(async (key: string) => {
      if (key === parkKey) {
        parkKeyReads++
        if (parkKeyReads === 1) {
          return originalGet(key)
        }
        // Simulate the sweeper having DEL'd the parkKey between the
        // resolver's GET (read #1) and the post-SETNX re-check (read #2+).
        return null
      }
      return originalGet(key)
    }) as typeof redisStub.get

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, resolveDeferredSession } = await import(
      "../defer-resolver.js"
    )
    setResumeIntentDispatcher(dispatcher)

    try {
      const result = await resolveDeferredSession({
        sessionId,
        signal: "payment.confirmed",
        event: paymentConfirmedEvent(),
        log: makeLogger(),
      })

      // (a) The resolver returned park_missing_after_lock — sweeper won.
      expect(result.kind).toBe("park_missing_after_lock")
      if (result.kind === "park_missing_after_lock") {
        expect(result.intentHash).toBe(envelope.intentHash)
      }
      // (a, cont.) NO mutation dispatched.
      expect(dispatcher).not.toHaveBeenCalled()
      // adjudicate() must not have been called either — we short-circuited
      // before re-adjudication.
      expect(mockAdjudicate).not.toHaveBeenCalled()
      // (b) defer.resume.skipped audit emitted with correct supersedes chain.
      expect(mockGetAuditSinkEmit).toHaveBeenCalledOnce()
      const auditRecord = (
        mockGetAuditSinkEmit.mock.calls as unknown as Array<[unknown]>
      )[0]![0] as {
        envelope: {
          actor: { principal: string }
          taint: string
        }
        decision: {
          kind: string
          refusal?: { kind: string; code: string; detail?: string }
        }
        decision_basis: ReadonlyArray<{
          category: string
          code: string
          detail?: Record<string, unknown>
        }>
        supersedes?: {
          predecessorIntentHash: string
          predecessorAt: string
          reason: string
        }
      }
      expect(auditRecord.decision.kind).toBe("REFUSE")
      expect(auditRecord.decision.refusal!.kind).toBe("BUSINESS_RULE")
      expect(auditRecord.decision.refusal!.code).toBe("defer.resume.skipped")
      expect(auditRecord.decision.refusal!.detail).toBe(
        "parkKey_missing_after_sweeper",
      )
      // System-actor envelope shape.
      expect(auditRecord.envelope.actor.principal).toBe("system")
      expect(auditRecord.envelope.taint).toBe("SYSTEM")
      // Basis carries the rule name for forensic clarity.
      const businessBasis = auditRecord.decision_basis.find(
        (b) => b.category === "business",
      )
      expect(businessBasis).toBeTruthy()
      expect(businessBasis!.code).toBe("rule_violated")
      expect(
        (businessBasis!.detail as { rule: string }).rule,
      ).toBe("parkKey_missing_after_sweeper")
      // Supersedes chain points back at the original parked envelope.
      expect(auditRecord.supersedes).toBeTruthy()
      expect(auditRecord.supersedes!.predecessorIntentHash).toBe(
        envelope.intentHash,
      )
      expect(auditRecord.supersedes!.predecessorAt).toBe(parkedAt)
      expect(auditRecord.supersedes!.reason).toBe("defer_resumed")
      // (c) Mutex was released — no defer:resuming:* key left behind.
      const resumingKeys = [...store.keys()].filter((k) =>
        k.startsWith("test:defer:resuming:"),
      )
      expect(resumingKeys).toHaveLength(0)
      // The cycle counter must NOT have been incremented — we short-circuited
      // before the INCR. (A counter increment on the loser path would be a
      // subtle cycle-cap drift bug.)
      const cycleKey = `test:defer:cycle:${envelope.intentHash}`
      expect(store.get(cycleKey)).toBeUndefined()
      // The long-term dedup ledger MUST NOT have been written — that's the
      // commit step that only the winner reaches.
      const resumedKeys = [...store.keys()].filter((k) =>
        k.startsWith("test:defer:resumed:"),
      )
      expect(resumedKeys).toHaveLength(0)
    } finally {
      redisStub.get = originalGet
      setResumeIntentDispatcher(null)
    }
  })

  it("[P1-D] transient error on first 2 attempts then success on 3rd — does NOT DLQ", async () => {
    const sessionId = "sess_redis_retry_success"
    const { envelope, parkedBlob } = buildVerifiableParkedBlob({ sessionId })
    store.set(`test:defer:pending:${sessionId}`, { value: parkedBlob, ttl: 800 })

    mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

    let attemptCount = 0
    const originalGet = redisStub.get.bind(redisStub)
    redisStub.get = vi.fn(async (key: string) => {
      attemptCount++
      if (attemptCount <= 2 && key.includes("defer:pending")) {
        throw new Error("transient blip")
      }
      return originalGet(key)
    }) as typeof redisStub.get

    const dispatcher = vi.fn(async () => undefined)
    const { setResumeIntentDispatcher, resolveDeferredSession } =
      await import("../defer-resolver.js")
    setResumeIntentDispatcher(dispatcher)

    const result = await resolveDeferredSession({
      sessionId,
      signal: "payment.confirmed",
      event: paymentConfirmedEvent(),
      log: makeLogger(),
    })

    expect(result.kind).toBe("re_adjudicated")
    expect(dispatcher).toHaveBeenCalledOnce()
    expect(envelope.intentHash).toBeTruthy()
    // No DLQ when the retry eventually succeeded.
    const dlqKeys = [...store.keys()].filter((k) => k.includes("dlq:"))
    expect(dlqKeys).toHaveLength(0)

    redisStub.get = originalGet
    setResumeIntentDispatcher(null)
  })
})
