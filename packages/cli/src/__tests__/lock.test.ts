// Tests for lib/lock.ts — Redis-based scenario lock.
// Mocks Redis adapter layer; never spins real Redis.

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup (vi.hoisted + vi.mock BEFORE imports) ─────────────────────────

const mockGet = vi.hoisted(() => vi.fn())
const mockSet = vi.hoisted(() => vi.fn())
const mockDel = vi.hoisted(() => vi.fn())
const mockGetRedis = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    get: mockGet,
    set: mockSet,
    del: mockDel,
  }),
)
const mockRk = vi.hoisted(() => vi.fn((key: string) => `test:${key}`))

vi.mock("../lib/redis.js", () => ({
  getRedis: mockGetRedis,
  rk: mockRk,
}))

// Freeze time for deterministic timestamps
vi.useFakeTimers()
vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"))

// ── Import source after mocks ────────────────────────────────────────────────

import { acquireScenarioLock, isScenarioLocked } from "../lib/lock.js"

// ── Tests ────────────────────────────────────────────────────────────────────

describe("acquireScenarioLock", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue(null)
    mockSet.mockResolvedValue("OK")
    mockDel.mockResolvedValue(1)
  })

  it("acquires the lock when no existing lock", async () => {
    const release = await acquireScenarioLock("homepage")

    expect(mockSet).toHaveBeenCalledWith(
      "test:ibx:scenario:lock",
      expect.stringContaining('"scenario":"homepage"'),
      { EX: 300 },
    )
    expect(typeof release).toBe("function")
  })

  it("sets correct lock info with scenario name and PID", async () => {
    await acquireScenarioLock("intel-test")

    const setCall = mockSet.mock.calls[0]
    const lockValue = JSON.parse(setCall[1])
    expect(lockValue.scenario).toBe("intel-test")
    expect(lockValue.pid).toBe(process.pid)
    expect(lockValue.startedAt).toBe("2025-06-01T12:00:00.000Z")
  })

  it("throws when another scenario is running (no force)", async () => {
    const existingLock = JSON.stringify({
      scenario: "other-scenario",
      pid: 99999,
      startedAt: "2025-06-01T11:55:00.000Z",
    })
    mockGet.mockResolvedValue(existingLock)

    await expect(acquireScenarioLock("homepage")).rejects.toThrow(
      /Another scenario is running: "other-scenario"/,
    )
    expect(mockSet).not.toHaveBeenCalled()
  })

  it("includes elapsed time in error message", async () => {
    const existingLock = JSON.stringify({
      scenario: "other-scenario",
      pid: 99999,
      startedAt: "2025-06-01T11:55:00.000Z",
    })
    mockGet.mockResolvedValue(existingLock)

    await expect(acquireScenarioLock("homepage")).rejects.toThrow(
      /started 300s ago/,
    )
  })

  it("acquires lock with force=true even when another is running", async () => {
    const existingLock = JSON.stringify({
      scenario: "other-scenario",
      pid: 99999,
      startedAt: "2025-06-01T11:55:00.000Z",
    })
    mockGet.mockResolvedValue(existingLock)

    const release = await acquireScenarioLock("homepage", { force: true })
    expect(mockSet).toHaveBeenCalled()
    expect(typeof release).toBe("function")
  })

  it("acquires lock when existing lock value is corrupted JSON", async () => {
    mockGet.mockResolvedValue("not-valid-json")

    // Corrupted lock should not block — force acquire
    const release = await acquireScenarioLock("homepage")
    expect(mockSet).toHaveBeenCalled()
    expect(typeof release).toBe("function")
  })

  describe("release function", () => {
    it("deletes the lock if we own it (same PID)", async () => {
      mockGet.mockResolvedValueOnce(null) // acquire
      const release = await acquireScenarioLock("homepage")

      // On release, mock get returns our lock
      const ourLock = JSON.stringify({
        scenario: "homepage",
        pid: process.pid,
        startedAt: "2025-06-01T12:00:00.000Z",
      })
      mockGet.mockResolvedValueOnce(ourLock)

      await release()
      expect(mockDel).toHaveBeenCalledWith("test:ibx:scenario:lock")
    })

    it("does NOT delete the lock if another PID owns it", async () => {
      mockGet.mockResolvedValueOnce(null) // acquire
      const release = await acquireScenarioLock("homepage")

      // On release, mock get returns a different PID's lock
      const otherLock = JSON.stringify({
        scenario: "other",
        pid: 88888,
        startedAt: "2025-06-01T12:00:00.000Z",
      })
      mockGet.mockResolvedValueOnce(otherLock)

      await release()
      expect(mockDel).not.toHaveBeenCalled()
    })

    it("deletes lock on corrupted JSON during release (best effort)", async () => {
      mockGet.mockResolvedValueOnce(null) // acquire
      const release = await acquireScenarioLock("homepage")

      mockGet.mockResolvedValueOnce("corrupted-json")

      await release()
      expect(mockDel).toHaveBeenCalledWith("test:ibx:scenario:lock")
    })

    it("does not throw if Redis is unavailable during release", async () => {
      mockGet.mockResolvedValueOnce(null) // acquire
      const release = await acquireScenarioLock("homepage")

      mockGetRedis.mockRejectedValueOnce(new Error("Redis disconnected"))

      await expect(release()).resolves.not.toThrow()
    })

    it("no-ops when lock no longer exists", async () => {
      mockGet.mockResolvedValueOnce(null) // acquire
      const release = await acquireScenarioLock("homepage")

      mockGet.mockResolvedValueOnce(null) // lock already gone

      await release()
      expect(mockDel).not.toHaveBeenCalled()
    })
  })
})

describe("isScenarioLocked", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns locked=false when no lock exists", async () => {
    mockGet.mockResolvedValue(null)
    const result = await isScenarioLocked()
    expect(result).toEqual({ locked: false })
  })

  it("returns locked=true with owner info when lock exists", async () => {
    const lockInfo = {
      scenario: "homepage",
      pid: 12345,
      startedAt: "2025-06-01T12:00:00.000Z",
    }
    mockGet.mockResolvedValue(JSON.stringify(lockInfo))

    const result = await isScenarioLocked()
    expect(result.locked).toBe(true)
    expect(result.owner).toEqual(lockInfo)
  })

  it("returns locked=false when Redis errors", async () => {
    mockGetRedis.mockRejectedValueOnce(new Error("Connection refused"))

    const result = await isScenarioLocked()
    expect(result).toEqual({ locked: false })
  })

  it("returns locked=false when lock value is corrupted JSON", async () => {
    mockGet.mockResolvedValue("not-json")

    const result = await isScenarioLocked()
    expect(result).toEqual({ locked: false })
  })
})
