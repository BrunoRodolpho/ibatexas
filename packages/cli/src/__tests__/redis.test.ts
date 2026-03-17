// Tests for lib/redis.ts — scan utilities (scanDelete, scanCount).
// Mocks the Redis client; never connects to real Redis.

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup ───────────────────────────────────────────────────────────────

const mockScan = vi.hoisted(() => vi.fn())
const mockDel = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/tools", () => ({
  rk: (key: string) => `test:${key}`,
  getRedisClient: vi.fn(),
  closeRedisClient: vi.fn(),
}))

// ── Import source after mocks ────────────────────────────────────────────────

import { scanDelete, scanCount } from "../lib/redis.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeRedisClient() {
  return {
    scan: mockScan,
    del: mockDel,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("scanDelete", () => {
  let redis: ReturnType<typeof makeRedisClient>

  beforeEach(() => {
    vi.clearAllMocks()
    redis = makeRedisClient()
    mockDel.mockResolvedValue(0)
  })

  it("returns 0 when no keys match", async () => {
    mockScan.mockResolvedValueOnce({ cursor: 0, keys: [] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleted = await scanDelete(redis as any, "test:copurchase:*")
    expect(deleted).toBe(0)
    expect(mockDel).not.toHaveBeenCalled()
  })

  it("deletes found keys and returns count", async () => {
    mockScan.mockResolvedValueOnce({
      cursor: 0,
      keys: ["test:copurchase:a", "test:copurchase:b"],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleted = await scanDelete(redis as any, "test:copurchase:*")
    expect(deleted).toBe(2)
    expect(mockDel).toHaveBeenCalledWith([
      "test:copurchase:a",
      "test:copurchase:b",
    ])
  })

  it("handles multiple scan iterations (cursor != 0)", async () => {
    mockScan
      .mockResolvedValueOnce({
        cursor: 42,
        keys: ["key-1", "key-2"],
      })
      .mockResolvedValueOnce({
        cursor: 0,
        keys: ["key-3"],
      })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleted = await scanDelete(redis as any, "test:*")
    expect(deleted).toBe(3)
    expect(mockDel).toHaveBeenCalledTimes(2)
  })

  it("passes MATCH pattern and COUNT to scan", async () => {
    mockScan.mockResolvedValueOnce({ cursor: 0, keys: [] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scanDelete(redis as any, "test:pattern:*")
    expect(mockScan).toHaveBeenCalledWith(0, {
      MATCH: "test:pattern:*",
      COUNT: 200,
    })
  })
})

describe("scanCount", () => {
  let redis: ReturnType<typeof makeRedisClient>

  beforeEach(() => {
    vi.clearAllMocks()
    redis = makeRedisClient()
  })

  it("returns 0 when no keys match", async () => {
    mockScan.mockResolvedValueOnce({ cursor: 0, keys: [] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await scanCount(redis as any, "test:*")
    expect(count).toBe(0)
  })

  it("returns total count across single iteration", async () => {
    mockScan.mockResolvedValueOnce({
      cursor: 0,
      keys: ["key-1", "key-2", "key-3"],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await scanCount(redis as any, "test:*")
    expect(count).toBe(3)
  })

  it("accumulates count across multiple scan iterations", async () => {
    mockScan
      .mockResolvedValueOnce({
        cursor: 10,
        keys: ["key-1", "key-2"],
      })
      .mockResolvedValueOnce({
        cursor: 20,
        keys: ["key-3", "key-4", "key-5"],
      })
      .mockResolvedValueOnce({
        cursor: 0,
        keys: ["key-6"],
      })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await scanCount(redis as any, "test:*")
    expect(count).toBe(6)
  })

  it("does not call del (count-only operation)", async () => {
    mockScan.mockResolvedValueOnce({
      cursor: 0,
      keys: ["key-1"],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scanCount(redis as any, "test:*")
    expect(mockDel).not.toHaveBeenCalled()
  })
})
