// Tests for schedule_follow_up tool
// Mock-based; no network or Redis required.
//
// Scenarios:
// - Entry added to sorted set with correct score (delay * 3600000 from now)
// - reason and customerId stored in JSON value
// - delayHours clamped to 1-72 range
// - returns error when customerId is missing from context

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Channel, type AgentContext } from "@ibatexas/types"
import { scheduleFollowUp } from "../../intelligence/schedule-follow-up.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockZAdd = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const mockGetRedisClient = vi.hoisted(() => vi.fn())
const mockRk = vi.hoisted(() => vi.fn((key: string) => `development:${key}`))

vi.mock("../../redis/client.js", () => ({
  getRedisClient: mockGetRedisClient,
}))

vi.mock("../../redis/key.js", () => ({
  rk: mockRk,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    channel: Channel.WhatsApp,
    sessionId: "sess_test",
    customerId: "cust_test",
    userType: "customer",
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("scheduleFollowUp", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRedisClient.mockResolvedValue({ zAdd: mockZAdd })
  })

  it("adds entry to sorted set with correct score", async () => {
    const before = Date.now()
    const ctx = makeCtx()
    const result = await scheduleFollowUp({ delayHours: 4, reason: "thinking" }, ctx)
    const after = Date.now()

    expect(result.success).toBe(true)
    expect(mockZAdd).toHaveBeenCalledOnce()

    const [key, entry] = mockZAdd.mock.calls[0] as [string, { score: number; value: string }]
    expect(key).toBe("development:follow-up:scheduled")
    expect(entry.score).toBeGreaterThanOrEqual(before + 4 * 3_600_000)
    expect(entry.score).toBeLessThanOrEqual(after + 4 * 3_600_000)
  })

  it("stores customerId and reason in the sorted set value", async () => {
    const ctx = makeCtx({ customerId: "cust_abc" })
    await scheduleFollowUp({ delayHours: 2, reason: "price_concern" }, ctx)

    const [, entry] = mockZAdd.mock.calls[0] as [string, { score: number; value: string }]
    const parsed = JSON.parse(entry.value) as { customerId: string; reason: string; scheduledAt: string }
    expect(parsed.customerId).toBe("cust_abc")
    expect(parsed.reason).toBe("price_concern")
    expect(parsed.scheduledAt).toBeDefined()
  })

  it("clamps delayHours below minimum to 1", async () => {
    const ctx = makeCtx()
    const result = await scheduleFollowUp({ delayHours: 0, reason: "thinking" }, ctx)

    expect(result.success).toBe(true)
    expect(result.message).toContain("1h")

    const [, entry] = mockZAdd.mock.calls[0] as [string, { score: number; value: string }]
    const expectedMin = Date.now() + 1 * 3_600_000 - 100 // small slack
    expect(entry.score).toBeGreaterThan(expectedMin)
  })

  it("clamps delayHours above maximum to 72", async () => {
    const ctx = makeCtx()
    const result = await scheduleFollowUp({ delayHours: 100, reason: "cart_save" }, ctx)

    expect(result.success).toBe(true)
    expect(result.message).toContain("72h")

    const [, entry] = mockZAdd.mock.calls[0] as [string, { score: number; value: string }]
    const expectedMax = Date.now() + 72 * 3_600_000 + 100 // small slack
    expect(entry.score).toBeLessThan(expectedMax)
  })

  it("returns error without customerId in context", async () => {
    const ctx = makeCtx({ customerId: undefined })
    const result = await scheduleFollowUp({ delayHours: 4, reason: "thinking" }, ctx)

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/autenticaç/i)
    expect(mockZAdd).not.toHaveBeenCalled()
  })
})

// ── The injected-client seam (F-35) ──────────────────────────────────────────
//
// The four cases above are the DEFAULT arm: no options bag, so the module must
// still resolve `getRedisClient()` from the relative import — that is what keeps
// the seam's default a measured fact rather than a comment, and it is why the
// existing suite was left untouched by this slice.
//
// This block is the other arm, and it asserts the one property that CANNOT be
// asserted from apps/api: that injecting a client leaves the package singleton
// UNRESOLVED. Over in apps/api the singleton is reached through a relative
// import a package-specifier mock cannot intercept — the whole reason F-35 was
// filed — so "the singleton was not touched" is only observable here, where the
// relative module itself is mocked. The driven producer→consumer parity proof
// lives in
// `apps/api/src/__tests__/jobs/follow-up-producer-consumer-parity.test.ts`.

describe("scheduleFollowUp — the injected-client seam", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRedisClient.mockResolvedValue({ zAdd: mockZAdd })
  })

  it("writes through the INJECTED client and never resolves the singleton", async () => {
    const injectedZAdd = vi.fn().mockResolvedValue(1)
    const result = await scheduleFollowUp(
      { delayHours: 4, reason: "thinking" },
      makeCtx(),
      { client: { zAdd: injectedZAdd } as never },
    )

    expect(result.success).toBe(true)
    // The write landed on the injected client...
    expect(injectedZAdd).toHaveBeenCalledOnce()
    const [key] = injectedZAdd.mock.calls[0] as [string, { score: number; value: string }]
    expect(key).toBe("development:follow-up:scheduled")
    // ...and BOTH halves of the singleton path stayed cold. `mockZAdd` is the
    // singleton's own command: asserting only `mockGetRedisClient` would leave a
    // module that resolved the singleton and then discarded it indistinguishable
    // from one that never asked.
    expect(mockGetRedisClient).not.toHaveBeenCalled()
    expect(mockZAdd).not.toHaveBeenCalled()
  })

  it("does not resolve ANY client on the unauthenticated arm, injected or not", async () => {
    const injectedZAdd = vi.fn().mockResolvedValue(1)
    const result = await scheduleFollowUp(
      { delayHours: 4, reason: "thinking" },
      makeCtx({ customerId: undefined }),
      { client: { zAdd: injectedZAdd } as never },
    )

    expect(result.success).toBe(false)
    expect(injectedZAdd).not.toHaveBeenCalled()
    // The non-hoisting rule, as an assertion: resolution sits AFTER the auth
    // guard, so the arm that reaches Redis never also asks for no client.
    expect(mockGetRedisClient).not.toHaveBeenCalled()
  })
})
