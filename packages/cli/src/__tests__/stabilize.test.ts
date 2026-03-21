// Tests for lib/stabilize.ts — state stabilization barrier.
// Mocks Medusa fetch and @ibatexas/tools; never hits real APIs.
import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup ───────────────────────────────────────────────────────────────

const mockMedusaFetch = vi.hoisted(() => vi.fn())
const mockGetAdminToken = vi.hoisted(() => vi.fn().mockResolvedValue("test-token"))
const mockIndexProductsBatch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockInvalidateAllQueryCache = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockDeleteEmbeddingCache = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockGetTypesenseClient = vi.hoisted(() => vi.fn())
const mockCOLLECTION = "products"

vi.mock("../lib/medusa.js", () => ({
  medusaFetch: mockMedusaFetch,
  getAdminToken: mockGetAdminToken,
}))

vi.mock("@ibatexas/tools", () => ({
  indexProductsBatch: mockIndexProductsBatch,
  invalidateAllQueryCache: mockInvalidateAllQueryCache,
  deleteEmbeddingCache: mockDeleteEmbeddingCache,
  getTypesenseClient: mockGetTypesenseClient,
  COLLECTION: mockCOLLECTION,
}))

// ── Import source after mocks ────────────────────────────────────────────────

import { stabilizeProducts, verifyTypesenseDoc } from "../lib/stabilize.js"

// ── Tests: stabilizeProducts ─────────────────────────────────────────────────

describe("stabilizeProducts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("no-ops for empty product IDs array", async () => {
    await stabilizeProducts([])
    expect(mockMedusaFetch).not.toHaveBeenCalled()
    expect(mockIndexProductsBatch).not.toHaveBeenCalled()
  })

  it("fetches products, deletes embedding cache, indexes, and flushes cache", async () => {
    mockMedusaFetch.mockResolvedValueOnce({ product: { id: "prod_1", title: "Brisket" } })

    await stabilizeProducts(["prod_1"])

    // Fetched product from Medusa
    expect(mockMedusaFetch).toHaveBeenCalledWith(
      expect.stringContaining("/admin/products/prod_1"),
      expect.objectContaining({ token: "test-token" }),
    )

    // Deleted embedding cache
    expect(mockDeleteEmbeddingCache).toHaveBeenCalledWith("prod_1")

    // Indexed into Typesense
    expect(mockIndexProductsBatch).toHaveBeenCalledWith([
      { id: "prod_1", title: "Brisket" },
    ])

    // Flushed query cache
    expect(mockInvalidateAllQueryCache).toHaveBeenCalled()
  })

  it("handles multiple product IDs", async () => {
    mockMedusaFetch
      .mockResolvedValueOnce({ product: { id: "prod_1" } })
      .mockResolvedValueOnce({ product: { id: "prod_2" } })

    await stabilizeProducts(["prod_1", "prod_2"])

    expect(mockMedusaFetch).toHaveBeenCalledTimes(2)
    expect(mockDeleteEmbeddingCache).toHaveBeenCalledTimes(2)
    expect(mockIndexProductsBatch).toHaveBeenCalledWith([
      { id: "prod_1" },
      { id: "prod_2" },
    ])
  })

  it("skips products that fail to fetch", async () => {
    mockMedusaFetch
      .mockRejectedValueOnce(new Error("Not found"))
      .mockResolvedValueOnce({ product: { id: "prod_2" } })

    await stabilizeProducts(["prod_1", "prod_2"])

    // Only prod_2 should be indexed
    expect(mockIndexProductsBatch).toHaveBeenCalledWith([{ id: "prod_2" }])
  })

  it("skips indexing when no products were fetched", async () => {
    mockMedusaFetch.mockResolvedValueOnce({ product: undefined })

    await stabilizeProducts(["prod_1"])

    expect(mockIndexProductsBatch).not.toHaveBeenCalled()
    expect(mockInvalidateAllQueryCache).not.toHaveBeenCalled()
  })

  it("continues if deleteEmbeddingCache fails (best effort)", async () => {
    mockMedusaFetch.mockResolvedValueOnce({ product: { id: "prod_1" } })
    mockDeleteEmbeddingCache.mockRejectedValueOnce(new Error("Cache miss"))

    await stabilizeProducts(["prod_1"])

    // Should still index despite embedding cache failure
    expect(mockIndexProductsBatch).toHaveBeenCalled()
  })
})

describe("verifyTypesenseDoc", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns true immediately when predicate passes on first check", async () => {
    const mockRetrieve = vi.fn().mockResolvedValue({ tags: ["popular"] })
    const mockDocuments = vi.fn(() => ({ retrieve: mockRetrieve }))
    const mockCollections = vi.fn(() => ({
      documents: mockDocuments,
    }))
    mockGetTypesenseClient.mockReturnValue({
      collections: mockCollections,
    })

    const resultPromise = verifyTypesenseDoc(
      "prod_1",
      (doc) => Array.isArray(doc.tags) && doc.tags.includes("popular"),
    )

    const result = await resultPromise
    expect(result).toBe(true)
    expect(mockRetrieve).toHaveBeenCalledTimes(1)
  })

  it("returns false when predicate never passes within timeout", async () => {
    const mockRetrieve = vi.fn().mockResolvedValue({ tags: [] })
    const mockDocuments = vi.fn(() => ({ retrieve: mockRetrieve }))
    const mockCollections = vi.fn(() => ({
      documents: mockDocuments,
    }))
    mockGetTypesenseClient.mockReturnValue({
      collections: mockCollections,
    })

    const resultPromise = verifyTypesenseDoc(
      "prod_1",
      (doc) => Array.isArray(doc.tags) && doc.tags.includes("popular"),
      500, // short timeout
      100, // short interval
    )

    // Advance time to exceed timeout
    // Need to advance in small steps to allow polling
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100)
    }

    const result = await resultPromise
    expect(result).toBe(false)
  })

  it("retries on retrieve errors (document may not exist yet)", async () => {
    const mockRetrieve = vi.fn()
      .mockRejectedValueOnce(new Error("Not found"))
      .mockResolvedValueOnce({ tags: ["popular"] })
    const mockDocuments = vi.fn(() => ({ retrieve: mockRetrieve }))
    const mockCollections = vi.fn(() => ({
      documents: mockDocuments,
    }))
    mockGetTypesenseClient.mockReturnValue({
      collections: mockCollections,
    })

    const resultPromise = verifyTypesenseDoc(
      "prod_1",
      (doc) => Array.isArray(doc.tags) && doc.tags.includes("popular"),
      3000,
      200,
    )

    // Advance timers to allow retry
    await vi.advanceTimersByTimeAsync(300)

    const result = await resultPromise
    expect(result).toBe(true)
  })
})
