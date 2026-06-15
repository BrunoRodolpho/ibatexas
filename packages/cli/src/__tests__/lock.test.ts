// Tests for lib/lock.ts — Redis-based scenario lock.
// In-memory Redis mock; never spins real Redis. Asserts atomic SET NX EX
// acquire and ownership-checked Lua release (CLAUDE.md rule #10).
import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup (vi.hoisted + vi.mock BEFORE imports) ─────────────────────────

// Minimal in-memory Redis: enough state to exercise NX contention and the
// conditional-DEL release script without a real server.
const store = vi.hoisted(() => new Map<string, string>())

const mockGet = vi.hoisted(() =>
  vi.fn(async (key: string) => store.get(key) ?? null),
)
const mockSet = vi.hoisted(() =>
  vi.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && store.has(key)) return null
    store.set(key, value)
    return "OK"
  }),
)
const mockDel = vi.hoisted(() =>
  vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
)
const mockEval = vi.hoisted(() =>
  vi.fn(async (_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
    // Emulates the conditional-DEL release script: DEL only on exact value match
    if (store.get(keys[0]) === args[0]) {
      store.delete(keys[0])
      return 1
    }
    return 0
  }),
)
const mockGetRedis = vi.hoisted(() =>
  vi.fn(async () => ({ get: mockGet, set: mockSet, del: mockDel, eval: mockEval })),
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

const LOCK_KEY = "test:ibx:scenario:lock"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── Tests ────────────────────────────────────────────────────────────────────

describe("acquireScenarioLock", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
  })

  it("acquires the lock atomically with SET NX EX", async () => {
    const release = await acquireScenarioLock("homepage")

    expect(mockSet).toHaveBeenCalledWith(
      LOCK_KEY,
      expect.stringContaining('"scenario":"homepage"'),
      { NX: true, EX: 300 },
    )
    expect(typeof release).toBe("function")
  })

  it("stores scenario name, PID, startedAt and a UUID token", async () => {
    await acquireScenarioLock("intel-test")

    const lockValue = JSON.parse(store.get(LOCK_KEY)!)
    expect(lockValue.scenario).toBe("intel-test")
    expect(lockValue.pid).toBe(process.pid)
    expect(lockValue.startedAt).toBe("2025-06-01T12:00:00.000Z")
    expect(lockValue.token).toMatch(UUID_RE)
  })

  it("generates a fresh token per acquisition", async () => {
    const releaseA = await acquireScenarioLock("homepage")
    const tokenA = JSON.parse(store.get(LOCK_KEY)!).token
    await releaseA()

    await acquireScenarioLock("homepage")
    const tokenB = JSON.parse(store.get(LOCK_KEY)!).token
    expect(tokenB).not.toBe(tokenA)
  })

  it("throws when another scenario is running (no force)", async () => {
    const existingLock = JSON.stringify({
      scenario: "other-scenario",
      pid: 99999,
      startedAt: "2025-06-01T11:55:00.000Z",
    })
    store.set(LOCK_KEY, existingLock)

    await expect(acquireScenarioLock("homepage")).rejects.toThrow(
      /Another scenario is running: "other-scenario"/,
    )
    // Contention must not overwrite the holder
    expect(store.get(LOCK_KEY)).toBe(existingLock)
  })

  it("includes elapsed time in error message", async () => {
    store.set(LOCK_KEY, JSON.stringify({
      scenario: "other-scenario",
      pid: 99999,
      startedAt: "2025-06-01T11:55:00.000Z",
    }))

    await expect(acquireScenarioLock("homepage")).rejects.toThrow(
      /started 300s ago/,
    )
  })

  it("acquires lock with force=true even when another is running", async () => {
    store.set(LOCK_KEY, JSON.stringify({
      scenario: "other-scenario",
      pid: 99999,
      startedAt: "2025-06-01T11:55:00.000Z",
    }))

    const release = await acquireScenarioLock("homepage", { force: true })
    // Force is a deliberate takeover — plain SET EX, no NX
    expect(mockSet).toHaveBeenCalledWith(LOCK_KEY, expect.any(String), { EX: 300 })
    expect(JSON.parse(store.get(LOCK_KEY)!).scenario).toBe("homepage")
    expect(typeof release).toBe("function")
  })

  it("acquires lock when existing lock value is corrupted JSON", async () => {
    store.set(LOCK_KEY, "not-valid-json")

    // Corrupted lock should not block — claim it
    const release = await acquireScenarioLock("homepage")
    expect(JSON.parse(store.get(LOCK_KEY)!).scenario).toBe("homepage")
    expect(typeof release).toBe("function")
  })

  describe("release function", () => {
    it("releases via conditional Lua script when we still hold the lock", async () => {
      const release = await acquireScenarioLock("homepage")
      const ourValue = store.get(LOCK_KEY)!

      await release()

      // Ownership-checked release: eval with our exact stored value, never plain DEL
      expect(mockEval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
        { keys: [LOCK_KEY], arguments: [ourValue] },
      )
      expect(mockDel).not.toHaveBeenCalled()
      expect(store.has(LOCK_KEY)).toBe(false)
    })

    it("does NOT delete the lock if another holder took it over", async () => {
      const release = await acquireScenarioLock("homepage")

      // Simulate TTL expiry + reacquisition by another process
      const otherLock = JSON.stringify({
        scenario: "other",
        pid: 88888,
        startedAt: "2025-06-01T12:00:00.000Z",
        token: "00000000-0000-4000-8000-000000000000",
      })
      store.set(LOCK_KEY, otherLock)

      await release()
      expect(store.get(LOCK_KEY)).toBe(otherLock)
      expect(mockDel).not.toHaveBeenCalled()
    })

    it("does not throw if Redis is unavailable during release", async () => {
      const release = await acquireScenarioLock("homepage")

      mockGetRedis.mockRejectedValueOnce(new Error("Redis disconnected"))

      await expect(release()).resolves.not.toThrow()
    })

    it("no-ops when lock no longer exists", async () => {
      const release = await acquireScenarioLock("homepage")
      store.delete(LOCK_KEY) // lock already gone (TTL expiry)

      await release()
      expect(mockDel).not.toHaveBeenCalled()
      expect(store.has(LOCK_KEY)).toBe(false)
    })
  })
})

describe("isScenarioLocked", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
  })

  it("returns locked=false when no lock exists", async () => {
    const result = await isScenarioLocked()
    expect(result).toEqual({ locked: false })
  })

  it("returns locked=true with owner info when lock exists", async () => {
    const lockInfo = {
      scenario: "homepage",
      pid: 12345,
      startedAt: "2025-06-01T12:00:00.000Z",
    }
    store.set(LOCK_KEY, JSON.stringify(lockInfo))

    const result = await isScenarioLocked()
    expect(result.locked).toBe(true)
    expect(result.owner).toMatchObject(lockInfo)
  })

  it("returns locked=false when Redis errors", async () => {
    mockGetRedis.mockRejectedValueOnce(new Error("Connection refused"))

    const result = await isScenarioLocked()
    expect(result).toEqual({ locked: false })
  })

  it("returns locked=false when lock value is corrupted JSON", async () => {
    store.set(LOCK_KEY, "not-json")

    const result = await isScenarioLocked()
    expect(result).toEqual({ locked: false })
  })
})
