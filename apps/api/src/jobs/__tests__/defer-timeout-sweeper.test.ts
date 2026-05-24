// Unit tests for the defer-timeout-sweeper BullMQ job — task 03.
//
// We exercise sweepDeferTimeouts() directly (no BullMQ, no network).
// Redis is replaced by a tiny in-memory stub with TTL semantics.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { deferResumeHash } from "@adjudicate/runtime"
import {
  sweepDeferTimeouts,
  startDeferTimeoutSweeper,
  stopDeferTimeoutSweeper,
  runRecoveryScan,
  type DeferTimeoutEventPayload,
} from "../defer-timeout-sweeper.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockSentryWithScope = vi.hoisted(() => vi.fn())
const mockSentryCaptureException = vi.hoisted(() => vi.fn())
const mockSentryCaptureMessage = vi.hoisted(() => vi.fn())

// ── In-memory Redis stub with TTL semantics ────────────────────────────────

interface Entry {
  value: string
  ttl: number // seconds remaining; -1 = no expire; -2 = missing key
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
      const had = store.delete(key)
      return had ? 1 : 0
    },
    async ttl(key: string): Promise<number> {
      const e = store.get(key)
      return e ? e.ttl : -2
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
  }
}

let redisStub: ReturnType<typeof makeRedisStub>

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => redisStub),
  rk: (key: string) => `test:${key}`,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

vi.mock("@sentry/node", () => ({
  withScope: mockSentryWithScope,
  captureException: mockSentryCaptureException,
  captureMessage: mockSentryCaptureMessage,
  init: vi.fn(),
}))

vi.mock("../queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLogger() {
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

function parkBlob(opts: {
  sessionId: string
  intentHash: string
  signal?: string
  parkedAt?: string
}): string {
  return JSON.stringify({
    envelope: {
      version: 2,
      kind: "order.confirm",
      payload: { orderId: "order_42" },
      createdAt: "2025-01-01T00:00:00.000Z",
      nonce: "nonce-1",
      actor: { principal: "user", sessionId: opts.sessionId },
      taint: "UNTRUSTED",
      intentHash: opts.intentHash,
      actorPrincipal: "user",
    },
    signal: opts.signal ?? "payment.confirmed",
    parkedAt: opts.parkedAt ?? "2025-01-01T00:00:00.000Z",
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("sweepDeferTimeouts", () => {
  beforeEach(() => {
    store.clear()
    vi.clearAllMocks()
    redisStub = makeRedisStub()
    mockSentryWithScope.mockImplementation((cb: (s: unknown) => void) =>
      cb({ setTag: vi.fn(), setContext: vi.fn() }),
    )
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await stopDeferTimeoutSweeper()
  })

  // ── 1. Publishes timeout and deletes key for an expired park ────────────

  it("publishes intent.defer.timeout and deletes the parked key when TTL is at the imminent threshold", async () => {
    const sessionId = "sess_expired"
    const intentHash = "ih_expired"
    store.set(`test:defer:pending:${sessionId}`, {
      value: parkBlob({ sessionId, intentHash }),
      // 1s remaining is well below the 60s imminent threshold — the
      // sweeper should treat this as expired.
      ttl: 1,
    })

    const count = await sweepDeferTimeouts(makeLogger())

    expect(count).toBe(1)
    expect(mockPublishNatsEvent).toHaveBeenCalledOnce()
    const [event, payload] = mockPublishNatsEvent.mock.calls[0] as unknown as [
      string,
      DeferTimeoutEventPayload,
    ]
    expect(event).toBe("intent.defer.timeout")
    expect(payload.sessionId).toBe(sessionId)
    expect(payload.intentHash).toBe(intentHash)
    expect(payload.signal).toBe("payment.confirmed")
    expect(payload.eventType).toBe("intent.defer.timeout")
    // Key was DEL'd after publish.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()
  })

  // ── 2. No-op when no expired keys exist ─────────────────────────────────

  it("publishes nothing when no expired parks exist", async () => {
    const count = await sweepDeferTimeouts(makeLogger())
    expect(count).toBe(0)
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
  })

  // ── 3. Skips keys with substantial TTL remaining ────────────────────────

  it("leaves keys alone when TTL is well above the imminent threshold", async () => {
    const sessionId = "sess_healthy"
    const intentHash = "ih_healthy"
    store.set(`test:defer:pending:${sessionId}`, {
      value: parkBlob({ sessionId, intentHash }),
      // 800s remaining — far above the 60s threshold.
      ttl: 800,
    })

    const count = await sweepDeferTimeouts(makeLogger())

    expect(count).toBe(0)
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()
  })

  // ── 4. Mixed batch: only the imminent keys are swept ────────────────────

  it("only sweeps the parks whose TTL is at or below the imminent threshold", async () => {
    store.set("test:defer:pending:sess_a", {
      value: parkBlob({ sessionId: "sess_a", intentHash: "ih_a" }),
      ttl: 5, // imminent
    })
    store.set("test:defer:pending:sess_b", {
      value: parkBlob({ sessionId: "sess_b", intentHash: "ih_b" }),
      ttl: 500, // healthy
    })
    store.set("test:defer:pending:sess_c", {
      value: parkBlob({ sessionId: "sess_c", intentHash: "ih_c" }),
      ttl: 60, // exactly at threshold
    })

    const count = await sweepDeferTimeouts(makeLogger())

    expect(count).toBe(2)
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(2)
    const publishedSessions = mockPublishNatsEvent.mock.calls.map(
      (call) => (call[1] as DeferTimeoutEventPayload).sessionId,
    )
    expect(publishedSessions.sort()).toEqual(["sess_a", "sess_c"])
    // sess_b is healthy — left alone.
    expect(store.get("test:defer:pending:sess_b")).toBeDefined()
    // sess_a and sess_c were DEL'd.
    expect(store.get("test:defer:pending:sess_a")).toBeUndefined()
    expect(store.get("test:defer:pending:sess_c")).toBeUndefined()
  })

  // ── 5. Malformed parked blob still publishes a minimal timeout ──────────

  it("publishes a minimal timeout (empty intentHash/signal) when the parked blob is malformed", async () => {
    store.set("test:defer:pending:sess_bad", {
      value: "{ not valid json",
      ttl: 1,
    })

    const count = await sweepDeferTimeouts(makeLogger())

    expect(count).toBe(1)
    expect(mockPublishNatsEvent).toHaveBeenCalledOnce()
    const [, payload] = mockPublishNatsEvent.mock.calls[0] as unknown as [
      string,
      DeferTimeoutEventPayload,
    ]
    expect(payload.sessionId).toBe("sess_bad")
    expect(payload.intentHash).toBe("")
    expect(payload.signal).toBe("")
    expect(store.get("test:defer:pending:sess_bad")).toBeUndefined()
  })

  // ── 6. publishNatsEvent failure: key is NOT deleted (retry next sweep) ──

  it("leaves the parked key in place when publishNatsEvent throws (retry next sweep)", async () => {
    const sessionId = "sess_pubfail"
    const intentHash = "ih_pubfail"
    store.set(`test:defer:pending:${sessionId}`, {
      value: parkBlob({ sessionId, intentHash }),
      ttl: 1,
    })

    mockPublishNatsEvent.mockRejectedValueOnce(new Error("nats down"))

    const count = await sweepDeferTimeouts(makeLogger())

    expect(count).toBe(0)
    // Key still there — next sweep will retry.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()
  })

  // ── audit-2026-05-24 P0-2: sweeper-vs-resolver mutex ─────────────────────

  it("[P0-2] acquires defer:resuming:{hash} mutex BEFORE publishing the timeout (legitimate case)", async () => {
    const sessionId = "sess_p0_2_alone"
    const intentHash = "ih_p0_2_alone"
    const signal = "payment.confirmed"
    store.set(`test:defer:pending:${sessionId}`, {
      value: parkBlob({ sessionId, intentHash, signal }),
      ttl: 1,
    })

    const count = await sweepDeferTimeouts(makeLogger())

    // Mutex acquired, timeout published, parked key DEL'd, mutex released.
    expect(count).toBe(1)
    expect(mockPublishNatsEvent).toHaveBeenCalledOnce()
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeUndefined()
    // The sweeper releases the mutex on commit so it doesn't linger.
    const mutexKey = `test:defer:resuming:${deferResumeHash(intentHash, signal)}`
    expect(store.get(mutexKey)).toBeUndefined()
  })

  it("[P0-2] skips publish when resolver mid-flight (defer:resuming:{hash} already claimed)", async () => {
    const sessionId = "sess_p0_2_race"
    const intentHash = "ih_p0_2_race"
    const signal = "payment.confirmed"
    store.set(`test:defer:pending:${sessionId}`, {
      value: parkBlob({ sessionId, intentHash, signal }),
      ttl: 1,
    })

    // Simulate the defer-resolver having SETNX'd the resuming marker
    // microseconds before the sweeper tick fires. The sweeper MUST NOT
    // publish a duplicate timeout — the resolver owns the resume.
    const mutexKey = `test:defer:resuming:${deferResumeHash(intentHash, signal)}`
    store.set(mutexKey, {
      value: JSON.stringify({
        at: new Date().toISOString(),
        sessionId,
        intentHash,
        signal,
      }),
      ttl: 60,
    })

    const count = await sweepDeferTimeouts(makeLogger())

    // No publish: sweeper saw resolver in-flight, backed off.
    expect(count).toBe(0)
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
    // The parked key MUST be preserved — the resolver owns its lifecycle and
    // will DEL on commit. A premature sweeper DEL would race the resolver.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()
    // The resolver's mutex marker is left intact (we didn't claim it).
    expect(store.get(mutexKey)).toBeDefined()
    // The recovery-fired marker we briefly claimed is released so a future
    // sweep (after the resolver completes or its lock expires) can re-fire
    // the timeout if needed.
    expect(store.get(`test:recovery:fired:${intentHash}`)).toBeUndefined()
  })

  it("[P0-2] recovery scan also respects the sweeper-vs-resolver mutex", async () => {
    const sessionId = "sess_p0_2_recovery_race"
    const intentHash = "ih_p0_2_recovery_race"
    const signal = "payment.confirmed"
    store.set(`test:defer:pending:${sessionId}`, {
      value: parkBlob({ sessionId, intentHash, signal }),
      ttl: 1,
    })

    // Resolver mid-flight at recovery time.
    const mutexKey = `test:defer:resuming:${deferResumeHash(intentHash, signal)}`
    store.set(mutexKey, {
      value: JSON.stringify({ at: "x", sessionId, intentHash, signal }),
      ttl: 60,
    })

    const count = await runRecoveryScan(makeLogger())

    // Recovery scan skips identically: no publish, parked key preserved.
    expect(count).toBe(0)
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()
    // Recovery-fired marker released so retry can re-claim.
    expect(store.get(`test:recovery:fired:${intentHash}`)).toBeUndefined()
  })

  // ── 7. [P1-E] Heartbeat is refreshed on every sweep tick ────────────────

  it("[P1-E] refreshes heartbeat:defer-sweeper on every sweep tick", async () => {
    await sweepDeferTimeouts(makeLogger())
    const hb = store.get("test:heartbeat:defer-sweeper")
    expect(hb).toBeDefined()
    expect(hb?.ttl).toBeGreaterThan(0)
    // Heartbeat TTL is 2x the repeat interval (60s * 2 = 120s).
    expect(hb?.ttl).toBe(120)
  })

  // ── Lifecycle ───────────────────────────────────────────────────────────

  it("startDeferTimeoutSweeper starts without throwing", () => {
    expect(() => startDeferTimeoutSweeper()).not.toThrow()
  })

  it("stopDeferTimeoutSweeper resolves when not started", async () => {
    await expect(stopDeferTimeoutSweeper()).resolves.toBeUndefined()
  })
})

// ── P1-E: Recovery scan tests ──────────────────────────────────────────────

describe("[P1-E] runRecoveryScan", () => {
  beforeEach(() => {
    store.clear()
    vi.clearAllMocks()
    redisStub = makeRedisStub()
    mockSentryWithScope.mockImplementation((cb: (s: unknown) => void) =>
      cb({ setTag: vi.fn(), setContext: vi.fn() }),
    )
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  it("publishes intent.defer.timeout for expired parks left behind during worker downtime", async () => {
    // Simulate worker outage: two parks with TTLs at the imminent threshold
    // are sitting in Redis because no sweep tick fired for them.
    store.set("test:defer:pending:sess_orphan_a", {
      value: parkBlob({ sessionId: "sess_orphan_a", intentHash: "ih_a" }),
      ttl: 3,
    })
    store.set("test:defer:pending:sess_orphan_b", {
      value: parkBlob({ sessionId: "sess_orphan_b", intentHash: "ih_b" }),
      ttl: 10,
    })
    // One healthy park — should NOT be touched by recovery scan.
    store.set("test:defer:pending:sess_healthy", {
      value: parkBlob({ sessionId: "sess_healthy", intentHash: "ih_h" }),
      ttl: 800,
    })

    const count = await runRecoveryScan(makeLogger())

    expect(count).toBe(2)
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(2)
    const publishedHashes = mockPublishNatsEvent.mock.calls.map(
      (call) => (call[1] as DeferTimeoutEventPayload).intentHash,
    )
    expect(publishedHashes.sort()).toEqual(["ih_a", "ih_b"])
    // Recovery-fired markers were SETNX'd, dedup keys exist.
    expect(store.get("test:recovery:fired:ih_a")).toBeDefined()
    expect(store.get("test:recovery:fired:ih_b")).toBeDefined()
    // Healthy park untouched.
    expect(store.get("test:defer:pending:sess_healthy")).toBeDefined()
    // Sentry-tagged info message for ops visibility.
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce()
  })

  it("does NOT double-fire: recovery scan then steady-state sweep produces one timeout per intent", async () => {
    store.set("test:defer:pending:sess_dual", {
      value: parkBlob({ sessionId: "sess_dual", intentHash: "ih_dual" }),
      ttl: 1,
    })

    // Recovery fires first.
    const recoveryCount = await runRecoveryScan(makeLogger())
    expect(recoveryCount).toBe(1)
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1)
    // Now re-park the same envelope to simulate the steady-state sweep
    // encountering the same intentHash again (e.g., if the recovery scan's
    // DEL of the parked key was somehow missed but the recovery-fired
    // marker SETNX'd). The recovery-fired marker still exists, so the
    // sweep should NOT republish.
    store.set("test:defer:pending:sess_dual", {
      value: parkBlob({ sessionId: "sess_dual", intentHash: "ih_dual" }),
      ttl: 1,
    })

    const sweepCount = await sweepDeferTimeouts(makeLogger())
    expect(sweepCount).toBe(0)
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1)
    // The sweep still cleans up the parked key (it's an idempotent op).
    expect(store.get("test:defer:pending:sess_dual")).toBeUndefined()
  })

  it("does not publish when there are no expired parks", async () => {
    store.set("test:defer:pending:sess_healthy", {
      value: parkBlob({ sessionId: "sess_healthy", intentHash: "ih_h" }),
      ttl: 800,
    })

    const count = await runRecoveryScan(makeLogger())
    expect(count).toBe(0)
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
    // No Sentry message when nothing was recovered.
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled()
  })

  it("publish failure releases the dedup marker so retry can re-claim it", async () => {
    const sessionId = "sess_pubfail_recovery"
    const intentHash = "ih_pubfail_recovery"
    store.set(`test:defer:pending:${sessionId}`, {
      value: parkBlob({ sessionId, intentHash }),
      ttl: 1,
    })

    mockPublishNatsEvent.mockRejectedValueOnce(new Error("nats down"))

    const count = await runRecoveryScan(makeLogger())
    expect(count).toBe(0)
    // Marker was released so the next attempt can re-claim it.
    expect(store.get(`test:recovery:fired:${intentHash}`)).toBeUndefined()
    // Parked key still there — next sweep retries.
    expect(store.get(`test:defer:pending:${sessionId}`)).toBeDefined()
  })
})
