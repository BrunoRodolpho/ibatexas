// Unit tests for the defer-timeout-sweeper BullMQ job — task 03.
//
// We exercise sweepDeferTimeouts() directly (no BullMQ, no network).
// Redis is replaced by a tiny in-memory stub with TTL semantics.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  sweepDeferTimeouts,
  startDeferTimeoutSweeper,
  stopDeferTimeoutSweeper,
  type DeferTimeoutEventPayload,
} from "../defer-timeout-sweeper.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockSentryWithScope = vi.hoisted(() => vi.fn())
const mockSentryCaptureException = vi.hoisted(() => vi.fn())

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

  // ── Lifecycle ───────────────────────────────────────────────────────────

  it("startDeferTimeoutSweeper starts without throwing", () => {
    expect(() => startDeferTimeoutSweeper()).not.toThrow()
  })

  it("stopDeferTimeoutSweeper resolves when not started", async () => {
    await expect(stopDeferTimeoutSweeper()).resolves.toBeUndefined()
  })
})
