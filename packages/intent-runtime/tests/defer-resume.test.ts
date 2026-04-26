// Tests for the DEFER consumer's idempotent resume path.
//
// The load-bearing invariant: regardless of how many duplicate webhook
// deliveries land for the same (intentHash, signal) pair, exactly one
// resume succeeds. All others return `duplicate_resume_suppressed`.
//
// Lives at the framework level (not in apps/api) because the invariant is
// a property of @adjudicate/intent-runtime semantics + ledger SET-NX dedup, not
// API-consumer behavior. apps/api wires the result to NATS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  deferResumeHash,
  resumeDeferredIntent,
  type DeferRedis,
} from "../src/defer-resume.js"

const mockGet = vi.fn()
const mockSet = vi.fn()
const mockDel = vi.fn()

const redis: DeferRedis = {
  get: mockGet as DeferRedis["get"],
  set: mockSet as DeferRedis["set"],
  del: mockDel as DeferRedis["del"],
}

const rk = (s: string) => `ENV:${s}`

describe("deferResumeHash (pure)", () => {
  it("produces sha256 hex", () => {
    expect(deferResumeHash("abc", "payment.confirmed")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is deterministic", () => {
    expect(deferResumeHash("abc", "x")).toBe(deferResumeHash("abc", "x"))
  })

  it("differs for different intents", () => {
    expect(deferResumeHash("a", "x")).not.toBe(deferResumeHash("b", "x"))
  })

  it("differs for different signals", () => {
    expect(deferResumeHash("a", "x")).not.toBe(deferResumeHash("a", "y"))
  })
})

describe("resumeDeferredIntent — idempotent SET NX semantics", () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockSet.mockReset()
    mockDel.mockReset().mockResolvedValue(1)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function parkedEnvelope(intentHash: string) {
    return JSON.stringify({
      envelope: {
        intentHash,
        kind: "order.confirm",
        actor: { sessionId: "s-1" },
        payload: { orderId: "ord_1" },
      },
      signal: "payment.confirmed",
      parkedAt: "2026-04-23T12:00:00.000Z",
    })
  }

  it("returns no_parked_envelope when key is missing", async () => {
    mockGet.mockResolvedValue(null)
    const result = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: "payment.confirmed",
      redis,
      rk,
    })
    expect(result.resumed).toBe(false)
    expect(result.reason).toBe("no_parked_envelope")
  })

  it("returns malformed_envelope on bad JSON", async () => {
    mockGet.mockResolvedValue("not-json{}{")
    const result = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: "payment.confirmed",
      redis,
      rk,
    })
    expect(result.resumed).toBe(false)
    expect(result.reason).toBe("malformed_envelope")
  })

  it("returns signal_mismatch when parked signal differs", async () => {
    mockGet.mockResolvedValue(parkedEnvelope("h1"))
    const result = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: "different.signal",
      redis,
      rk,
    })
    expect(result.resumed).toBe(false)
    expect(result.reason).toBe("signal_mismatch")
  })

  it("first call wins — returns resumed: true", async () => {
    mockGet.mockResolvedValue(parkedEnvelope("h1"))
    mockSet.mockResolvedValue("OK")
    const result = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: "payment.confirmed",
      redis,
      rk,
    })
    expect(result.resumed).toBe(true)
    expect(result.intentHash).toBe("h1")
    expect(mockDel).toHaveBeenCalled()
  })

  it("second call suppressed — returns duplicate_resume_suppressed", async () => {
    mockGet.mockResolvedValue(parkedEnvelope("h1"))
    mockSet.mockResolvedValue(null) // SET NX rejected — already exists
    const result = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: "payment.confirmed",
      redis,
      rk,
    })
    expect(result.resumed).toBe(false)
    expect(result.reason).toBe("duplicate_resume_suppressed")
    expect(result.intentHash).toBe("h1")
    expect(mockDel).not.toHaveBeenCalled()
  })

  it("invariant: SET NX is called with the resume token key", async () => {
    mockGet.mockResolvedValue(parkedEnvelope("h1"))
    mockSet.mockResolvedValue("OK")
    await resumeDeferredIntent({
      sessionId: "s-1",
      signal: "payment.confirmed",
      redis,
      rk,
    })
    const expectedHash = deferResumeHash("h1", "payment.confirmed")
    expect(mockSet).toHaveBeenCalledWith(
      `ENV:defer:resumed:${expectedHash}`,
      expect.any(String),
      expect.objectContaining({ NX: true, EX: 14 * 24 * 60 * 60 }),
    )
  })
})

describe("invariant: N concurrent webhook deliveries → exactly 1 resume", () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockSet.mockReset()
    mockDel.mockReset().mockResolvedValue(1)
  })

  it.each([2, 5, 10, 25, 50])("holds for N=%i concurrent calls", async (n) => {
    let acquired = false
    mockGet.mockResolvedValue(
      JSON.stringify({
        envelope: {
          intentHash: `hash_for_${n}`,
          kind: "order.confirm",
          actor: { sessionId: "s" },
          payload: {},
        },
        signal: "payment.confirmed",
        parkedAt: "2026-04-23T12:00:00.000Z",
      }),
    )
    mockSet.mockImplementation(async () => {
      if (acquired) return null
      acquired = true
      return "OK"
    })

    const results = await Promise.all(
      Array.from({ length: n }, () =>
        resumeDeferredIntent({
          sessionId: "s",
          signal: "payment.confirmed",
          redis,
          rk,
        }),
      ),
    )
    const resumedCount = results.filter((r) => r.resumed).length
    expect(resumedCount).toBe(1)
    expect(
      results.filter((r) => r.reason === "duplicate_resume_suppressed").length,
    ).toBe(n - 1)
  })
})
