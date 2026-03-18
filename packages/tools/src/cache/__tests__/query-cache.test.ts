// Tests for query cache: bucketing, hashing, hit persistence, and invalidation
//
// Two-layer architecture under test:
//   L0: Exact match  — sha256(normalize(query)+filters)
//   L1: Semantic     — djb2(quantized embedding)
//
// All Redis calls are mocked — no network required.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Channel } from "@ibatexas/types"
import type { ProductDTO } from "@ibatexas/types"
import {
  embeddingToBucket,
  exactCacheKey,
  allergenFilterHash,
  getExactQueryCache,
  setExactQueryCache,
  getQueryCache,
  setQueryCache,
  incrementQueryCacheHits,
  invalidateAllQueryCache,
  logQuery,
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

// ── crypto.randomUUID mock for logQuery determinism ────────────────────────────

const mockUUID = vi.hoisted(() => "a1b2c3d4-e5f6-7890-abcd-ef1234567890")

vi.stubGlobal("crypto", {
  ...crypto,
  randomUUID: vi.fn(() => mockUUID),
})

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

/** Minimal ProductDTO stub */
function stubProduct(handle: string): ProductDTO {
  return { handle } as unknown as ProductDTO
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Query Cache", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedis.get.mockResolvedValue(null)
    mockRedis.del.mockResolvedValue(0)
    mockRedis.setEx.mockResolvedValue("OK")
    mockRedis.scanIterator.mockReturnValue(makeAsyncIterator([]))
  })

  // ── embeddingToBucket — pure ───────────────────────────────────────────────

  describe("embeddingToBucket — pure", () => {
    it("returns bucket_NNN format", () => {
      const embedding = [0.1, 0.2, 0.3, -0.4, 0.5]
      const bucket = embeddingToBucket(embedding)
      expect(bucket).toMatch(/^bucket_\d+$/)
    })

    it("same input → same bucket (deterministic)", () => {
      const embedding = Array(1536).fill(0.5)
      const results = Array.from({ length: 10 }, () => embeddingToBucket(embedding))
      expect(new Set(results).size).toBe(1)
    })

    it("different inputs → likely different buckets", () => {
      const a = Array(1536).fill(0.9)
      const b = Array(1536).fill(-0.9)
      expect(embeddingToBucket(a)).not.toBe(embeddingToBucket(b))
    })

    it("empty array → consistent bucket", () => {
      const b1 = embeddingToBucket([])
      const b2 = embeddingToBucket([])
      expect(b1).toBe(b2)
      expect(b1).toMatch(/^bucket_\d+$/)
    })

    it("sign matters: [0.5] and [-0.5] produce different buckets", () => {
      expect(embeddingToBucket([0.5])).not.toBe(embeddingToBucket([-0.5]))
    })

    it("bucket number is in range 0–999", () => {
      const embeddings = [
        Array(1536).fill(0.7),
        Array(1536).fill(-0.3),
        Array(1536).fill(0),
        [1, 2, 3],
      ]
      for (const emb of embeddings) {
        const n = Number.parseInt(embeddingToBucket(emb).replace("bucket_", ""), 10)
        expect(n).toBeGreaterThanOrEqual(0)
        expect(n).toBeLessThan(1000)
      }
    })

    it("bucket string has no decimal point (integer modulo)", () => {
      const bucket = embeddingToBucket(Array(1536).fill(0.123456))
      expect(bucket).not.toMatch(/\./)
    })
  })

  // ── exactCacheKey — pure ───────────────────────────────────────────────────

  describe("exactCacheKey — pure", () => {
    it("normalizes query: trims, lowercases, collapses whitespace", () => {
      const ctx = defaultCtx()
      const k1 = exactCacheKey("  Costela  Bovina  ", ctx)
      const k2 = exactCacheKey("costela bovina", ctx)
      expect(k1).toBe(k2)
    })

    it("same query with different casing → same key", () => {
      const ctx = defaultCtx()
      const k1 = exactCacheKey("Linguica Defumada", ctx)
      const k2 = exactCacheKey("LINGUICA DEFUMADA", ctx)
      const k3 = exactCacheKey("linguica defumada", ctx)
      expect(k1).toBe(k2)
      expect(k2).toBe(k3)
    })

    it("includes channel in key prefix", () => {
      const webKey = exactCacheKey("costela", defaultCtx({ channel: Channel.Web }))
      const waKey = exactCacheKey("costela", defaultCtx({ channel: Channel.WhatsApp }))
      expect(webKey).toContain("search_exact:web:")
      expect(waKey).toContain("search_exact:whatsapp:")
    })

    it("different filters → different keys", () => {
      const k1 = exactCacheKey("costela", defaultCtx({ allergenHash: "abc123" }))
      const k2 = exactCacheKey("costela", defaultCtx({ allergenHash: "def456" }))
      expect(k1).not.toBe(k2)
    })

    it("handles optional productType", () => {
      const k1 = exactCacheKey("costela", defaultCtx({ productType: "meat" }))
      const k2 = exactCacheKey("costela", defaultCtx({ productType: undefined }))
      expect(k1).not.toBe(k2)
    })

    it("handles optional categoryHandle", () => {
      const k1 = exactCacheKey("costela", defaultCtx({ categoryHandle: "defumados" }))
      const k2 = exactCacheKey("costela", defaultCtx({ categoryHandle: undefined }))
      expect(k1).not.toBe(k2)
    })

    it("handles optional tags", () => {
      const k1 = exactCacheKey("costela", defaultCtx({ tags: ["promo", "new"] }))
      const k2 = exactCacheKey("costela", defaultCtx({ tags: undefined }))
      expect(k1).not.toBe(k2)
    })

    it("tags order does not affect key (sorted before hashing)", () => {
      const k1 = exactCacheKey("costela", defaultCtx({ tags: ["promo", "new"] }))
      const k2 = exactCacheKey("costela", defaultCtx({ tags: ["new", "promo"] }))
      expect(k1).toBe(k2)
    })

    it("key format is search_exact:{channel}:{16-char hex}", () => {
      const key = exactCacheKey("brisket", defaultCtx())
      expect(key).toMatch(/^search_exact:web:[a-f0-9]{16}$/)
    })
  })

  // ── allergenFilterHash — pure ──────────────────────────────────────────────

  describe("allergenFilterHash — pure", () => {
    it("returns empty string for undefined", () => {
      expect(allergenFilterHash(undefined)).toBe("")
    })

    it("returns empty string for empty array", () => {
      expect(allergenFilterHash([])).toBe("")
    })

    it("order-independent: ['nuts','lactose'] == ['lactose','nuts']", () => {
      const h1 = allergenFilterHash(["nuts", "lactose"])
      const h2 = allergenFilterHash(["lactose", "nuts"])
      expect(h1).toBe(h2)
    })

    it("different allergens → different hash", () => {
      expect(allergenFilterHash(["lactose"])).not.toBe(allergenFilterHash(["nuts"]))
    })

    it("returns a hex string up to 6 chars", () => {
      const hash = allergenFilterHash(["gluten", "eggs", "soy"])
      expect(hash).toMatch(/^[a-f0-9]{1,6}$/)
    })

    it("is deterministic across multiple calls", () => {
      const results = Array.from({ length: 5 }, () => allergenFilterHash(["lactose", "gluten"]))
      expect(new Set(results).size).toBe(1)
    })
  })

  // ── getExactQueryCache ─────────────────────────────────────────────────────

  describe("getExactQueryCache", () => {
    it("returns hit:true with results when cached", async () => {
      const products = [stubProduct("costela-bovina")]
      const cachedAt = "2026-03-16T10:00:00.000Z"
      mockRedis.get.mockResolvedValueOnce(JSON.stringify({ results: products, cachedAt }))

      const result = await getExactQueryCache("costela bovina", defaultCtx())

      expect(result.hit).toBe(true)
      if (result.hit) {
        expect(result.results).toEqual(products)
        expect(result.cachedAt).toBe(cachedAt)
      }
    })

    it("returns hit:false when not cached", async () => {
      mockRedis.get.mockResolvedValueOnce(null)

      const result = await getExactQueryCache("something uncached", defaultCtx())

      expect(result.hit).toBe(false)
    })

    it("returns hit:false on Redis error (graceful)", async () => {
      mockRedis.get.mockRejectedValueOnce(new Error("Redis connection lost"))

      const result = await getExactQueryCache("costela", defaultCtx())

      expect(result.hit).toBe(false)
    })
  })

  // ── setExactQueryCache ─────────────────────────────────────────────────────

  describe("setExactQueryCache", () => {
    let envBackup: string | undefined

    afterEach(() => {
      if (envBackup === undefined) {
        delete process.env.QUERY_CACHE_EXACT_TTL_SECONDS
      } else {
        process.env.QUERY_CACHE_EXACT_TTL_SECONDS = envBackup
      }
    })

    it("writes to Redis with correct TTL", async () => {
      envBackup = process.env.QUERY_CACHE_EXACT_TTL_SECONDS
      delete process.env.QUERY_CACHE_EXACT_TTL_SECONDS

      const products = [stubProduct("linguica")]
      await setExactQueryCache("linguica", defaultCtx(), products)

      expect(mockRedis.setEx).toHaveBeenCalledOnce()
      const [key, ttl, payload] = mockRedis.setEx.mock.calls[0]
      expect(key).toMatch(/^search_exact:web:/)
      expect(ttl).toBe(300) // default
      const parsed = JSON.parse(payload)
      expect(parsed.results).toEqual(products)
      expect(parsed.cachedAt).toBeDefined()
    })

    it("uses QUERY_CACHE_EXACT_TTL_SECONDS env var", async () => {
      envBackup = process.env.QUERY_CACHE_EXACT_TTL_SECONDS
      process.env.QUERY_CACHE_EXACT_TTL_SECONDS = "600"

      await setExactQueryCache("costela", defaultCtx(), [])

      const [, ttl] = mockRedis.setEx.mock.calls[0]
      expect(ttl).toBe(600)
    })

    it("silently fails on Redis error", async () => {
      envBackup = process.env.QUERY_CACHE_EXACT_TTL_SECONDS
      mockRedis.setEx.mockRejectedValueOnce(new Error("Redis write failed"))

      // Should not throw
      await expect(setExactQueryCache("test", defaultCtx(), [])).resolves.toBeUndefined()
    })
  })

  // ── getQueryCache ──────────────────────────────────────────────────────────

  describe("getQueryCache", () => {
    it("returns hit:true with L1 cached results", async () => {
      const products = [stubProduct("brisket")]
      const entry = {
        embedding: [0.1, 0.2],
        bucket: "bucket_42",
        results: products,
        resultCount: 1,
        hitCount: 3,
        cachedAt: "2026-03-16T10:00:00.000Z",
        expiresAt: "2026-03-16T11:00:00.000Z",
      }
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry))

      const result = await getQueryCache([0.1, 0.2], defaultCtx())

      expect(result.hit).toBe(true)
      if (result.hit) {
        expect(result.results).toEqual(products)
        expect(result.cachedAt).toBe("2026-03-16T10:00:00.000Z")
      }
    })

    it("returns hit:false when not cached", async () => {
      mockRedis.get.mockResolvedValueOnce(null)

      const result = await getQueryCache([0.5, 0.5], defaultCtx())

      expect(result.hit).toBe(false)
    })

    it("returns hit:false on Redis error (graceful)", async () => {
      mockRedis.get.mockRejectedValueOnce(new Error("Redis timeout"))

      const result = await getQueryCache([0.1], defaultCtx())

      expect(result.hit).toBe(false)
    })
  })

  // ── setQueryCache ──────────────────────────────────────────────────────────

  describe("setQueryCache", () => {
    let envBackup: string | undefined

    afterEach(() => {
      if (envBackup === undefined) {
        delete process.env.QUERY_CACHE_TTL_SECONDS
      } else {
        process.env.QUERY_CACHE_TTL_SECONDS = envBackup
      }
    })

    it("writes entry with all fields (embedding, bucket, resultCount, etc.)", async () => {
      envBackup = process.env.QUERY_CACHE_TTL_SECONDS
      const embedding = [0.1, 0.2, 0.3]
      const products = [stubProduct("costela"), stubProduct("brisket")]

      await setQueryCache(embedding, products, defaultCtx())

      expect(mockRedis.setEx).toHaveBeenCalledOnce()
      const [key, , payload] = mockRedis.setEx.mock.calls[0]
      expect(key).toContain("search_cache:")
      const parsed = JSON.parse(payload)
      expect(parsed.embedding).toEqual(embedding)
      expect(parsed.bucket).toBe(embeddingToBucket(embedding))
      expect(parsed.resultCount).toBe(2)
      expect(parsed.hitCount).toBe(0)
      expect(parsed.cachedAt).toBeDefined()
      expect(parsed.expiresAt).toBeDefined()
      expect(parsed.results).toEqual(products)
    })

    it("uses custom TTL when provided", async () => {
      envBackup = process.env.QUERY_CACHE_TTL_SECONDS

      await setQueryCache([0.1], [], defaultCtx(), 1800)

      const [, ttl] = mockRedis.setEx.mock.calls[0]
      expect(ttl).toBe(1800)
    })

    it("uses QUERY_CACHE_TTL_SECONDS env var default", async () => {
      envBackup = process.env.QUERY_CACHE_TTL_SECONDS
      process.env.QUERY_CACHE_TTL_SECONDS = "7200"

      await setQueryCache([0.3], [], defaultCtx())

      const [, ttl] = mockRedis.setEx.mock.calls[0]
      expect(ttl).toBe(7200)
    })

    it("uses 3600 when env var is absent", async () => {
      envBackup = process.env.QUERY_CACHE_TTL_SECONDS
      delete process.env.QUERY_CACHE_TTL_SECONDS

      await setQueryCache([0.3], [], defaultCtx())

      const [, ttl] = mockRedis.setEx.mock.calls[0]
      expect(ttl).toBe(3600)
    })

    it("silently fails on Redis error", async () => {
      envBackup = process.env.QUERY_CACHE_TTL_SECONDS
      mockRedis.setEx.mockRejectedValueOnce(new Error("Redis write failed"))

      await expect(setQueryCache([0.1], [], defaultCtx())).resolves.toBeUndefined()
    })

    it("different channels produce different cache keys", async () => {
      envBackup = process.env.QUERY_CACHE_TTL_SECONDS
      const embedding = [0.5, 0.5]

      await setQueryCache(embedding, [], defaultCtx({ channel: Channel.Web }))
      const webKey = mockRedis.setEx.mock.calls[0][0]

      vi.clearAllMocks()
      mockRedis.setEx.mockResolvedValue("OK")

      await setQueryCache(embedding, [], defaultCtx({ channel: Channel.WhatsApp }))
      const whatsappKey = mockRedis.setEx.mock.calls[0][0]

      expect(webKey).not.toBe(whatsappKey)
      expect(webKey).toContain("web")
      expect(whatsappKey).toContain("whatsapp")
    })
  })

  // ── incrementQueryCacheHits ────────────────────────────────────────────────

  describe("incrementQueryCacheHits", () => {
    it("increments hitCount and writes back", async () => {
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

      expect(mockRedis.setEx).toHaveBeenCalledOnce()
      const [, , serialized] = mockRedis.setEx.mock.calls[0]
      const written = JSON.parse(serialized)
      expect(written.hitCount).toBe(3)
    })

    it("uses remaining TTL from expiresAt", async () => {
      const now = new Date()
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

    it("no-op when key not in Redis", async () => {
      mockRedis.get.mockResolvedValueOnce(null)

      await incrementQueryCacheHits(Array(1536).fill(0.5), defaultCtx())

      expect(mockRedis.setEx).not.toHaveBeenCalled()
    })

    it("falls back to env TTL when expiresAt is in the past", async () => {
      const now = new Date()
      // expiresAt already passed
      const expiresAt = new Date(now.getTime() - 100 * 1000).toISOString()
      const embedding = [0.1, 0.2]

      const existingEntry = {
        embedding,
        bucket: embeddingToBucket(embedding),
        results: [],
        resultCount: 0,
        hitCount: 5,
        cachedAt: now.toISOString(),
        expiresAt,
      }

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(existingEntry))

      await incrementQueryCacheHits(embedding, defaultCtx())

      const [, ttl] = mockRedis.setEx.mock.calls[0]
      // Should fallback to default TTL (3600) since remaining <= 0
      expect(ttl).toBe(3600)
    })

    it("silently fails on Redis error", async () => {
      mockRedis.get.mockRejectedValueOnce(new Error("Redis down"))

      await expect(
        incrementQueryCacheHits([0.1], defaultCtx()),
      ).resolves.toBeUndefined()
    })
  })

  // ── invalidateAllQueryCache ────────────────────────────────────────────────

  describe("invalidateAllQueryCache", () => {
    it("scans and deletes both search_cache:* and search_exact:*", async () => {
      const l1Keys = ["search_cache:web:bucket_42:all:none:all:all:none", "search_cache:whatsapp:bucket_7:dynamic:ae3f2b:all:all:none"]
      const l0Keys = ["search_exact:web:abc123def456", "search_exact:web:deadbeef1234"]

      mockRedis.scanIterator
        .mockReturnValueOnce(makeAsyncIterator(l1Keys))
        .mockReturnValueOnce(makeAsyncIterator(l0Keys))

      const count = await invalidateAllQueryCache()

      expect(mockRedis.del).toHaveBeenCalledOnce()
      const deletedKeys: string[] = mockRedis.del.mock.calls[0][0]
      expect(deletedKeys).toEqual(expect.arrayContaining([...l1Keys, ...l0Keys]))
      expect(count).toBe(4)
    })

    it("scans with correct MATCH patterns for L0 and L1", async () => {
      mockRedis.scanIterator
        .mockReturnValueOnce(makeAsyncIterator([]))
        .mockReturnValueOnce(makeAsyncIterator([]))

      await invalidateAllQueryCache()

      const calls = mockRedis.scanIterator.mock.calls
      expect(calls).toHaveLength(2)
      expect(calls[0][0]).toMatchObject({ MATCH: "development:search_cache:*" })
      expect(calls[1][0]).toMatchObject({ MATCH: "development:search_exact:*" })
    })

    it("returns count of deleted keys", async () => {
      const keys = ["search_cache:web:bucket_1:all:none:all:all:none"]
      mockRedis.scanIterator
        .mockReturnValueOnce(makeAsyncIterator(keys))
        .mockReturnValueOnce(makeAsyncIterator([]))

      const count = await invalidateAllQueryCache()

      expect(count).toBe(1)
    })

    it("returns 0 on empty", async () => {
      mockRedis.scanIterator
        .mockReturnValueOnce(makeAsyncIterator([]))
        .mockReturnValueOnce(makeAsyncIterator([]))

      const count = await invalidateAllQueryCache()

      expect(mockRedis.del).not.toHaveBeenCalled()
      expect(count).toBe(0)
    })

    it("returns 0 on Redis error (non-critical)", async () => {
      mockRedis.scanIterator.mockImplementation(() => {
        throw new Error("Redis connection lost")
      })

      await expect(invalidateAllQueryCache()).resolves.toBe(0)
    })
  })

  // ── logQuery ───────────────────────────────────────────────────────────────

  describe("logQuery", () => {
    let envBackup: string | undefined

    afterEach(() => {
      if (envBackup === undefined) {
        delete process.env.QUERY_LOG_TTL_SECONDS
      } else {
        process.env.QUERY_LOG_TTL_SECONDS = envBackup
      }
    })

    it("writes log entry with correct key format and TTL", async () => {
      envBackup = process.env.QUERY_LOG_TTL_SECONDS
      delete process.env.QUERY_LOG_TTL_SECONDS

      await logQuery("session-123", "costela bovina", "bucket_42", 5, Channel.Web, "customer")

      expect(mockRedis.setEx).toHaveBeenCalledOnce()
      const [key, ttl, payload] = mockRedis.setEx.mock.calls[0]

      // Key format: query_log:{timestamp}:{sessionId}:{8-char uuid prefix}
      expect(key).toMatch(/^query_log:.+:session-123:a1b2c3d4$/)
      expect(ttl).toBe(604800) // default 7 days
      const parsed = JSON.parse(payload)
      expect(parsed.sessionId).toBe("session-123")
      expect(parsed.queryText).toBe("costela bovina")
      expect(parsed.bucket).toBe("bucket_42")
      expect(parsed.resultsCount).toBe(5)
      expect(parsed.channel).toBe("web")
      expect(parsed.userType).toBe("customer")
      expect(parsed.timestamp).toBeDefined()
    })

    it("uses QUERY_LOG_TTL_SECONDS env var when set", async () => {
      envBackup = process.env.QUERY_LOG_TTL_SECONDS
      process.env.QUERY_LOG_TTL_SECONDS = "86400"

      await logQuery("s1", "test", "bucket_0", 0, Channel.WhatsApp, "guest")

      const [, ttl] = mockRedis.setEx.mock.calls[0]
      expect(ttl).toBe(86400)
    })

    it("uses uuid prefix from crypto.randomUUID for key uniqueness", async () => {
      envBackup = process.env.QUERY_LOG_TTL_SECONDS

      await logQuery("s1", "test", "bucket_0", 0, Channel.Web, "staff")

      const [key] = mockRedis.setEx.mock.calls[0]
      // The mock UUID "a1b2c3d4-e5f6-7890-abcd-ef1234567890" sliced to 8 chars = "a1b2c3d4"
      expect(key).toContain("a1b2c3d4")
    })

    it("silently fails on Redis error", async () => {
      envBackup = process.env.QUERY_LOG_TTL_SECONDS
      mockRedis.setEx.mockRejectedValueOnce(new Error("Redis write failed"))

      await expect(
        logQuery("s1", "test", "bucket_0", 0, Channel.Web, "guest"),
      ).resolves.toBeUndefined()
    })
  })
})
