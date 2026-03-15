// Tests for query cache: bucketing, hashing, hit persistence, and invalidation

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Channel } from "@ibatexas/types"
import {
  embeddingToBucket,
  allergenFilterHash,
  incrementQueryCacheHits,
  invalidateAllQueryCache,
  setQueryCache,
  type CacheFilterContext,
} from "../query-cache.js"

// ── Redis mock ─────────────────────────────────────────────────────────────────
// Must use vi.hoisted() so mockRedis is available inside the vi.mock() factory
// (vi.mock factories are hoisted to the top of the file before const declarations)

const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  setEx: vi.fn().mockResolvedValue("OK"),
  del: vi.fn().mockResolvedValue(0),
  scanIterator: vi.fn(),
}))

vi.mock("../../redis/client.js", () => ({
  getRedisClient: vi.fn().mockResolvedValue(mockRedis),
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Generate an async iterable from a plain array (for scanIterator mocking) */
function makeAsyncIterator(items: string[]) {
  return (async function* () {
    for (const item of items) yield item
  })()
}

/** Default cache filter context for tests */
function defaultCtx(overrides?: Partial<CacheFilterContext>): CacheFilterContext {
  return {
    channel: Channel.Web,
    availabilityMode: "all",
    allergenHash: "",
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Query Cache", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedis.get.mockResolvedValue(null)
    mockRedis.del.mockResolvedValue(0)
    mockRedis.scanIterator.mockReturnValue(makeAsyncIterator([]))
  })

  // ── embeddingToBucket ────────────────────────────────────────────────────────

  describe("embeddingToBucket", () => {
    it("buckets identical embeddings to the same bucket", () => {
      const embedding = Array(1536).fill(0.5)
      expect(embeddingToBucket(embedding)).toBe(embeddingToBucket(embedding))
    })

    it("returns a bucket in format 'bucket_N' (integer, no decimal point)", () => {
      const embedding = Array(1536).fill(0.5)
      const bucket = embeddingToBucket(embedding)

      expect(bucket).toMatch(/^bucket_\d+$/)
      // Critical: must NOT contain a decimal point — was broken before (float modulo)
      expect(bucket).not.toMatch(/\./)
    })

    it("bucket number is in range 0–999 (fixed 1000 bucket space)", () => {
      const embedding = Array(1536).fill(0.7)
      const bucket = embeddingToBucket(embedding)
      const n = Number.parseInt(bucket.replace("bucket_", ""), 10)

      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(1000)
    })

    it("opposite-direction embeddings land in different buckets (sign-aware)", () => {
      // All positive vs all negative — semantically opposite queries
      const positive = Array(1536).fill(1)
      const negative = Array(1536).fill(-1)

      expect(embeddingToBucket(positive)).not.toBe(embeddingToBucket(negative))
    })

    it("produces different buckets for very different embeddings", () => {
      const a = Array(1536).fill(0.9)
      const b = Array(1536).fill(-0.9)

      expect(embeddingToBucket(a)).not.toBe(embeddingToBucket(b))
    })

    it("is deterministic across multiple calls", () => {
      const embedding = Array(1536).fill(0).map((_, i) => (i % 2 === 0 ? 0.3 : -0.3))
      const results = Array.from({ length: 5 }, () => embeddingToBucket(embedding))

      expect(new Set(results).size).toBe(1) // all identical
    })
  })

  // ── allergenFilterHash ───────────────────────────────────────────────────────

  describe("allergenFilterHash", () => {
    it("returns empty string for no allergens", () => {
      expect(allergenFilterHash()).toBe("")
      expect(allergenFilterHash([])).toBe("")
    })

    it("returns consistent hash for same allergens", () => {
      const hash1 = allergenFilterHash(["lactose", "nuts"])
      const hash2 = allergenFilterHash(["lactose", "nuts"])
      expect(hash1).toBe(hash2)
    })

    it("returns same hash regardless of array order (order-independent)", () => {
      const hash1 = allergenFilterHash(["lactose", "nuts"])
      const hash2 = allergenFilterHash(["nuts", "lactose"])
      expect(hash1).toBe(hash2)
    })

    it("returns different hashes for different allergen sets", () => {
      expect(allergenFilterHash(["lactose"])).not.toBe(allergenFilterHash(["nuts"]))
    })

    it("returns 6-char lowercase hex string", () => {
      const hash = allergenFilterHash(["gluten", "eggs"])
      expect(hash).toMatch(/^[a-f0-9]{6}$/)
    })
  })

  // ── incrementQueryCacheHits ──────────────────────────────────────────────────

  describe("incrementQueryCacheHits", () => {
    it("writes back incremented hitCount via setEx (not just expire)", async () => {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000).toISOString()
      const embedding = Array(1536).fill(0.5)

      const existingEntry = {
        embedding,
        bucket: embeddingToBucket(embedding),
        results: [],
        resultCount: 0,
        hitCount: 2,
        cachedAt: now.toISOString(),
        expiresAt,
      }

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(existingEntry))

      await incrementQueryCacheHits(embedding, defaultCtx())

      // Must call setEx (write back), NOT just expire (resets TTL without saving hitCount)
      expect(mockRedis.setEx).toHaveBeenCalledOnce()

      const [, , serialized] = mockRedis.setEx.mock.calls[0]
      const written = JSON.parse(serialized)

      expect(written.hitCount).toBe(3) // was 2, now 3
    })

    it("uses remaining TTL from expiresAt (not a hardcoded 3600)", async () => {
      const now = new Date()
      // Expires in exactly 1800 seconds from now
      const expiresAt = new Date(now.getTime() + 1800 * 1000).toISOString()
      const embedding = Array(1536).fill(0.1)

      const existingEntry = {
        embedding,
        bucket: embeddingToBucket(embedding),
        results: [],
        resultCount: 0,
        hitCount: 0,
        cachedAt: now.toISOString(),
        expiresAt,
      }

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(existingEntry))

      await incrementQueryCacheHits(embedding, defaultCtx())

      const [, ttl] = mockRedis.setEx.mock.calls[0]
      // TTL should be approximately 1800 (within ±5 seconds for test timing)
      expect(ttl).toBeGreaterThan(1790)
      expect(ttl).toBeLessThanOrEqual(1800)
    })

    it("is a no-op when cache entry does not exist", async () => {
      mockRedis.get.mockResolvedValueOnce(null)

      await incrementQueryCacheHits(Array(1536).fill(0.5), defaultCtx())

      expect(mockRedis.setEx).not.toHaveBeenCalled()
    })
  })

  // ── invalidateAllQueryCache ──────────────────────────────────────────────────

  describe("invalidateAllQueryCache", () => {
    it("deletes both search_cache:* and search_exact:* keys", async () => {
      const l1Keys = ["search_cache:web:bucket_42:all:none", "search_cache:whatsapp:bucket_7:dynamic:ae3f2b"]
      const l0Keys = ["search_exact:web:abc123def456", "search_exact:web:deadbeef1234"]

      mockRedis.scanIterator
        .mockReturnValueOnce(makeAsyncIterator(l1Keys)) // first call: search_cache:*
        .mockReturnValueOnce(makeAsyncIterator(l0Keys)) // second call: search_exact:*

      const count = await invalidateAllQueryCache()

      expect(mockRedis.del).toHaveBeenCalledOnce()
      const deletedKeys: string[] = mockRedis.del.mock.calls[0][0]
      expect(deletedKeys).toEqual(expect.arrayContaining([...l1Keys, ...l0Keys]))
      expect(count).toBe(4)
    })

    it("scans with correct MATCH patterns for L0 and L1 caches", async () => {
      mockRedis.scanIterator
        .mockReturnValueOnce(makeAsyncIterator([]))
        .mockReturnValueOnce(makeAsyncIterator([]))

      await invalidateAllQueryCache()

      const calls = mockRedis.scanIterator.mock.calls
      expect(calls).toHaveLength(2)
      expect(calls[0][0]).toMatchObject({ MATCH: "search_cache:*" })
      expect(calls[1][0]).toMatchObject({ MATCH: "search_exact:*" })
    })

    it("returns 0 and does not call del when cache is empty", async () => {
      mockRedis.scanIterator
        .mockReturnValueOnce(makeAsyncIterator([]))
        .mockReturnValueOnce(makeAsyncIterator([]))

      const count = await invalidateAllQueryCache()

      expect(mockRedis.del).not.toHaveBeenCalled()
      expect(count).toBe(0)
    })

    it("returns 0 and does not throw on Redis error (non-critical)", async () => {
      mockRedis.scanIterator.mockImplementation(() => {
        throw new Error("Redis connection lost")
      })

      await expect(invalidateAllQueryCache()).resolves.toBe(0)
    })
  })

  // ── setQueryCache ────────────────────────────────────────────────────────────

  describe("setQueryCache", () => {
    it("uses QUERY_CACHE_TTL_SECONDS env var for TTL (not hardcoded)", async () => {
      const originalEnv = process.env.QUERY_CACHE_TTL_SECONDS
      process.env.QUERY_CACHE_TTL_SECONDS = "7200"

      const embedding = Array(1536).fill(0.3)
      await setQueryCache(embedding, [], defaultCtx())

      const [, ttl] = mockRedis.setEx.mock.calls[0]
      expect(ttl).toBe(7200)

      // Restore original env var; use delete if it was originally absent
      // (process.env.KEY = undefined stores the string "undefined", not removes it)
      if (originalEnv === undefined) {
        delete process.env.QUERY_CACHE_TTL_SECONDS
      } else {
        process.env.QUERY_CACHE_TTL_SECONDS = originalEnv
      }
    })
  })

  // ── Channel enum ─────────────────────────────────────────────────────────────

  describe("Channel enum as cache key component", () => {
    it("Channel.Web produces a valid cache key with 'web' segment", async () => {
      const embedding = Array(1536).fill(0.5)
      await setQueryCache(embedding, [], defaultCtx({ channel: Channel.Web }))

      const [key] = mockRedis.setEx.mock.calls[0]
      expect(key).toContain("web")
    })

    it("Channel.WhatsApp produces a valid cache key with 'whatsapp' segment", async () => {
      const embedding = Array(1536).fill(0.5)
      await setQueryCache(embedding, [], defaultCtx({ channel: Channel.WhatsApp }))

      const [key] = mockRedis.setEx.mock.calls[0]
      expect(key).toContain("whatsapp")
    })

    it("Channel.Web and Channel.WhatsApp produce different cache keys for the same embedding", async () => {
      const embedding = Array(1536).fill(0.5)

      await setQueryCache(embedding, [], defaultCtx({ channel: Channel.Web }))
      const webKey = mockRedis.setEx.mock.calls[0][0]

      vi.clearAllMocks()
      mockRedis.setEx.mockResolvedValue("OK")

      await setQueryCache(embedding, [], defaultCtx({ channel: Channel.WhatsApp }))
      const whatsappKey = mockRedis.setEx.mock.calls[0][0]

      expect(webKey).not.toBe(whatsappKey)
    })
  })
})
