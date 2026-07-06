// Tests for the restaurant schedule cache (schedule-cache.ts) — BKL-124.
//
// Covers the two hardening properties:
//   (a) setCachedSchedule writes with a BOUNDED TTL (SCHEDULE_CACHE_TTL_SECONDS,
//       default 300s), so a swallowed invalidation can only serve a stale snapshot
//       for at most the TTL before the key expires and the read-through re-reads DB.
//   (b) invalidateScheduleCache is OBSERVABLE — it returns a success/failure
//       outcome and retries the DEL once, instead of silently swallowing failures.
//
// Redis client is mocked; safeRedis + the real circuit breaker run for real (the
// breaker is reset per test so a deliberate throw here never leaks into the next).

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { RestaurantSchedule } from "@ibatexas/domain"

// ── Redis mock (exercised through the real safeRedis + circuit breaker) ──────────
const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}))

vi.mock("../../redis/client.js", () => ({
  getRedisClient: vi.fn().mockResolvedValue(mockRedis),
}))

// createScheduleService is only reached by loadSchedule's DB fallback (cache miss).
const mockGetFullSchedule = vi.hoisted(() => vi.fn())
vi.mock("@ibatexas/domain", () => ({
  createScheduleService: () => ({ getFullSchedule: mockGetFullSchedule }),
}))

import {
  getCachedSchedule,
  setCachedSchedule,
  invalidateScheduleCache,
  loadSchedule,
} from "../schedule-cache.js"
import { rk } from "../../redis/key.js"
import { resetCircuitBreaker } from "../../redis/circuit-breaker.js"

const SCHEDULE_KEY = rk("restaurant:schedule")

function stubSchedule(): RestaurantSchedule {
  return { days: {}, holidays: [], overrides: [] } as unknown as RestaurantSchedule
}

beforeEach(() => {
  vi.clearAllMocks()
  resetCircuitBreaker()
  delete process.env.SCHEDULE_CACHE_TTL_SECONDS
  // Sensible defaults; individual tests override.
  mockRedis.set.mockResolvedValue("OK")
  mockRedis.del.mockResolvedValue(1)
})

// ── (a) bounded TTL on write ────────────────────────────────────────────────────

describe("setCachedSchedule — bounded TTL", () => {
  it("writes the schedule with the default 300s EX TTL", async () => {
    const schedule = stubSchedule()
    await setCachedSchedule(schedule)
    expect(mockRedis.set).toHaveBeenCalledWith(
      SCHEDULE_KEY,
      JSON.stringify(schedule),
      { EX: 300 },
    )
  })

  it("honors the SCHEDULE_CACHE_TTL_SECONDS override", async () => {
    process.env.SCHEDULE_CACHE_TTL_SECONDS = "60"
    await setCachedSchedule(stubSchedule())
    expect(mockRedis.set).toHaveBeenCalledWith(SCHEDULE_KEY, expect.any(String), { EX: 60 })
  })

  it("falls back to 300s when the override is non-positive (never 'no expiry')", async () => {
    process.env.SCHEDULE_CACHE_TTL_SECONDS = "0"
    await setCachedSchedule(stubSchedule())
    expect(mockRedis.set).toHaveBeenCalledWith(SCHEDULE_KEY, expect.any(String), { EX: 300 })
  })

  it("falls back to 300s when the override is non-numeric", async () => {
    process.env.SCHEDULE_CACHE_TTL_SECONDS = "abc"
    await setCachedSchedule(stubSchedule())
    expect(mockRedis.set).toHaveBeenCalledWith(SCHEDULE_KEY, expect.any(String), { EX: 300 })
  })
})

// ── read-through after TTL expiry ────────────────────────────────────────────────

describe("getCachedSchedule / loadSchedule — read-through", () => {
  it("returns null when the key is gone (expired or evicted)", async () => {
    mockRedis.get.mockResolvedValue(null)
    expect(await getCachedSchedule()).toBeNull()
  })

  it("re-reads from the DB and re-populates the cache (WITH TTL) after the key expires", async () => {
    mockRedis.get.mockResolvedValue(null) // expired / missing
    const fresh = stubSchedule()
    mockGetFullSchedule.mockResolvedValue(fresh)

    const result = await loadSchedule()

    expect(result).toEqual(fresh)
    expect(mockGetFullSchedule).toHaveBeenCalledTimes(1)
    // The re-populated snapshot carries the TTL, so it cannot become immortal.
    expect(mockRedis.set).toHaveBeenCalledWith(
      SCHEDULE_KEY,
      JSON.stringify(fresh),
      { EX: 300 },
    )
  })

  it("serves the cached snapshot without a DB read while the key is live", async () => {
    const cached = stubSchedule()
    mockRedis.get.mockResolvedValue(JSON.stringify(cached))

    const result = await loadSchedule()

    expect(result).toEqual(cached)
    expect(mockGetFullSchedule).not.toHaveBeenCalled()
  })
})

// ── (b) observable, retried invalidation ─────────────────────────────────────────

describe("invalidateScheduleCache — observable + retried", () => {
  it("returns { ok: true } on a successful DEL and does NOT retry", async () => {
    mockRedis.del.mockResolvedValue(1)
    const outcome = await invalidateScheduleCache()
    expect(outcome).toEqual({ ok: true })
    expect(mockRedis.del).toHaveBeenCalledTimes(1)
  })

  it("treats a DEL of an already-absent key (returns 0) as success", async () => {
    mockRedis.del.mockResolvedValue(0)
    const outcome = await invalidateScheduleCache()
    expect(outcome).toEqual({ ok: true })
    expect(mockRedis.del).toHaveBeenCalledTimes(1)
  })

  it("retries ONCE and reports { ok: false } when the DEL keeps failing (swallowed by safeRedis)", async () => {
    mockRedis.del.mockRejectedValue(new Error("redis down"))
    const outcome = await invalidateScheduleCache()
    expect(outcome).toEqual({ ok: false })
    expect(mockRedis.del).toHaveBeenCalledTimes(2)
  })

  it("recovers on the retry when the first DEL throws but the second succeeds", async () => {
    mockRedis.del.mockRejectedValueOnce(new Error("transient blip")).mockResolvedValueOnce(1)
    const outcome = await invalidateScheduleCache()
    expect(outcome).toEqual({ ok: true })
    expect(mockRedis.del).toHaveBeenCalledTimes(2)
  })
})
