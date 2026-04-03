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
