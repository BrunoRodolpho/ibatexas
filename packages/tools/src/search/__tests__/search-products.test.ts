// Tests for search_products tool
// Mock-based; no database or network required.
//
// Critical regressions tested:
// - vector_query uses actual embedding values (not empty `[]`)
// - typesenseDocToDTO maps flat Typesense fields (price, allergens) correctly
// - filter_by includes status:published && inStock:true
// - excludeAllergens correctly removes products from results
// - isAvailableNow() edge cases (boundary hours)
// - L0 exact cache short-circuits before embedding (zero API cost)
// - queries[] runs parallel searches and returns queriesResults
// - Duplicate products across queries are deduped (first occurrence wins)
// - totalFound reflects Typesense response.found (not products.length)
// - noResultsReason diagnostic for empty results
// - scores present on live search, absent on cache hit
// - NATS event published as product.viewed (not product.searched)
// - One product.viewed event per product in merged results

import { describe, it, expect, beforeEach, vi } from "vitest"
import { SearchProductsInputSchema, Channel } from "@ibatexas/types"
import type { ProductDTO } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { searchProducts, SearchProductsTool } from "../search-products.js"
import {
  getExactQueryCache,
  getQueryCache,
} from "../../cache/query-cache.js"

// ── Hoisted mocks (available inside vi.mock factories before module loading) ───

const mockTypesenseSearch = vi.hoisted(() => vi.fn())
const mockGenerateEmbedding = vi.hoisted(() => vi.fn())

// ── Module mocks ──────────────────────────────────────────────────────────────
// Paths are relative to THIS file: search/__tests__/search-products.test.ts
// Target modules live at: typesense/client.ts, embeddings/client.ts, etc.

vi.mock("../../typesense/client.js", () => ({
  getTypesenseClient: vi.fn(() => ({
    multiSearch: {
      perform: mockTypesenseSearch,
    },
  })),
  ensureCollectionExists: vi.fn(),
  COLLECTION: "products",
}))

vi.mock("../../embeddings/client.js", () => ({
  generateEmbedding: mockGenerateEmbedding,
}))

vi.mock("../../cache/query-cache.js", () => ({
  getExactQueryCache: vi.fn().mockResolvedValue({ hit: false }),
  setExactQueryCache: vi.fn().mockResolvedValue(undefined),
  getQueryCache: vi.fn().mockResolvedValue({ hit: false }),
  setQueryCache: vi.fn().mockResolvedValue(undefined),
  incrementQueryCacheHits: vi.fn().mockResolvedValue(undefined),
  logQuery: vi.fn().mockResolvedValue(undefined),
  allergenFilterHash: vi.fn().mockReturnValue(""),
  embeddingToBucket: vi.fn().mockReturnValue("bucket_42"),
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn().mockResolvedValue(undefined),
}))

// Note: mappers/product-mapper.js is NOT mocked — we use the real
// typesenseDocToDTO to verify mapper correctness (Bug 6 regression).

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_EMBEDDING = Array(1536).fill(0.1)

/** Flat Typesense document (NOT a Medusa product — different shape). */
const makeTypesenseDoc = (overrides: Record<string, unknown> = {}) => ({
  id: "prod_1",
  title: "Costela Bovina Defumada",
  description: "Costela premium 500g defumada lentamente",
  price: 8900,
  imageUrl: "https://example.com/costela.jpg",
  tags: ["popular", "carne"],
  availabilityWindow: "sempre", // always available — avoids time-of-day flakiness
  allergens: ["latex"],
  variants: [],
  productType: "food",
  status: "published",
  inStock: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdAtTimestamp: Date.now(),
  ...overrides,
})

/** A Typesense hit with relevance score (hybrid search result shape) */
const makeHit = (doc: Record<string, unknown>, score = 0.9) => ({
  document: doc,
  hybrid_search_info: { rank_fusion_score: score },
  text_match_score: score,
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("searchProducts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset defaults: embedding succeeds, Typesense returns one doc, cache misses
    mockGenerateEmbedding.mockResolvedValue(TEST_EMBEDDING)
    mockTypesenseSearch.mockResolvedValue({
      results: [{
        hits: [makeHit(makeTypesenseDoc())],
        found: 1,
      }],
    })
    // Reset cache mocks to cache-miss state (vi.clearAllMocks() clears implementations)
    vi.mocked(getExactQueryCache).mockResolvedValue({ hit: false })
    vi.mocked(getQueryCache).mockResolvedValue({ hit: false })
  })

  // ── Input validation ─────────────────────────────────────────────────────────

  describe("input validation", () => {
    it("rejects empty query string", () => {
      expect(() => SearchProductsInputSchema.parse({ query: "" })).toThrow()
    })

    it("rejects query longer than 200 characters", () => {
      expect(() =>
        SearchProductsInputSchema.parse({ query: "a".repeat(201) })
      ).toThrow()
    })

    it("rejects limit > 100", () => {
      expect(() =>
        SearchProductsInputSchema.parse({ query: "test", limit: 101 })
      ).toThrow()
    })

    it("accepts valid input with all optional fields", () => {
      expect(() =>
        SearchProductsInputSchema.parse({
          query: "costela",
          limit: 5,
          tags: ["popular"],
          availableNow: true,
          excludeAllergens: ["gluten"],
        })
      ).not.toThrow()
    })

    it("requires at least query or queries — rejects neither", () => {
      expect(() => SearchProductsInputSchema.parse({ limit: 5 })).toThrow()
    })

    it("accepts queries[] without query", () => {
      expect(() =>
        SearchProductsInputSchema.parse({ queries: ["costela de porco", "costela de boi"] })
      ).not.toThrow()
    })

    it("rejects queries[] with more than 5 items", () => {
      expect(() =>
        SearchProductsInputSchema.parse({
          queries: ["a", "b", "c", "d", "e", "f"],
        })
      ).toThrow()
    })
  })

  // ── Typesense query correctness ──────────────────────────────────────────────

  describe("Typesense search call", () => {
    it("sends actual embedding values in vector_query — not empty brackets (Bug 3 regression)", async () => {
      await searchProducts({ query: "costela bovina" })

      expect(mockTypesenseSearch).toHaveBeenCalledOnce()
      const args = mockTypesenseSearch.mock.calls[0][0].searches[0]

      // Must NOT be the old broken syntax: embedding:([], ...)
      expect(args.vector_query).not.toContain("([]")
      // Must contain actual comma-separated floating-point values
      expect(args.vector_query).toMatch(/^embedding:\(\[[\d.,\-e]+/)
      // Must end with k: parameter
      expect(args.vector_query).toMatch(/k:\d+\)$/)
    })

    it("includes filter_by: status:published && inStock:true (hides out-of-stock/draft)", async () => {
      await searchProducts({ query: "costela" })

      const args = mockTypesenseSearch.mock.calls[0][0].searches[0]
      expect(args.filter_by).toContain("status:published")
      expect(args.filter_by).toContain("inStock:true")
    })

    it("passes limit to per_page", async () => {
      await searchProducts({ query: "costela", limit: 3 })

      const args = mockTypesenseSearch.mock.calls[0][0].searches[0]
      expect(args.per_page).toBe(3)
    })

    it("falls back to keyword-only search when embedding fails", async () => {
      mockGenerateEmbedding.mockRejectedValueOnce(new Error("OpenAI rate limited"))

      const result = await searchProducts({ query: "costela" })

      expect(result.searchModel).toBe("keyword")
      expect(result.products).toBeDefined()
    })

    it("sets searchModel: hybrid when embedding succeeds", async () => {
      const result = await searchProducts({ query: "costela" })
      expect(result.searchModel).toBe("hybrid")
    })

    it("does not pass vector_query when embedding fails", async () => {
      mockGenerateEmbedding.mockRejectedValueOnce(new Error("API unavailable"))

      await searchProducts({ query: "costela" })

      const args = mockTypesenseSearch.mock.calls[0][0].searches[0]
      // vector_query should be absent or undefined (not empty brackets)
      expect(args.vector_query).toBeUndefined()
    })
  })

  // ── totalFound ────────────────────────────────────────────────────────────────

  describe("totalFound", () => {
    it("reflects Typesense response.found — not products.length", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          // response.found=12 but only 5 hits returned (per_page limit)
          hits: [makeHit(makeTypesenseDoc())],
          found: 12,
        }],
      })

      const result = await searchProducts({ query: "costela" })

      expect(result.totalFound).toBe(12)
      expect(result.products.length).toBe(1)
    })

    it("is 0 when Typesense returns no results", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [], found: 0 }] })

      const result = await searchProducts({ query: "algo raro" })

      expect(result.totalFound).toBe(0)
    })
  })

  // ── scores ────────────────────────────────────────────────────────────────────

  describe("scores", () => {
    it("includes scores on live search (not on cache hit)", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(makeTypesenseDoc({ id: "prod_abc" }), 0.87)],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "costela" })

      expect(result.scores).toBeDefined()
      expect(result.scores!["prod_abc"]).toBeCloseTo(0.87, 2)
    })

    it("scores absent on L0 cache hit (zero-cost hit has no live search data)", async () => {
      vi.mocked(getExactQueryCache).mockResolvedValueOnce({
        hit: true,
        results: [makeTypesenseDoc() as unknown as ProductDTO],
        cachedAt: new Date().toISOString(),
      })

      const result = await searchProducts({ query: "costela" })

      expect(result.hitCache).toBe(true)
      expect(result.scores).toBeUndefined()
    })

    it("scores absent on L1 cache hit", async () => {
      vi.mocked(getQueryCache).mockResolvedValueOnce({
        hit: true,
        results: [makeTypesenseDoc() as unknown as ProductDTO],
        cachedAt: new Date().toISOString(),
      })

      const result = await searchProducts({ query: "costela bovina" })

      expect(result.hitCache).toBe(true)
      expect(result.scores).toBeUndefined()
    })
  })

  // ── noResultsReason ──────────────────────────────────────────────────────────

  describe("noResultsReason", () => {
    it("out_of_stock: when Typesense finds docs without inStock filter but not with", async () => {
      // Primary call (with inStock:true): no results
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [], found: 0 }] })
      // Diagnostic call (without inStock): finds OOS products
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(makeTypesenseDoc({ inStock: false }))],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "costela" })

      expect(result.products).toHaveLength(0)
      expect(result.noResultsReason).toBe("out_of_stock")
    })

    it("no_match: when Typesense finds nothing even without inStock filter", async () => {
      // Primary call: no results
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [], found: 0 }] })
      // Diagnostic call: still no results
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [], found: 0 }] })

      const result = await searchProducts({ query: "produto inexistente xyz" })

      expect(result.products).toHaveLength(0)
      expect(result.noResultsReason).toBe("no_match")
    })

    it("allergen_filtered: when allergen filter removes all primary results", async () => {
      // Primary call returns docs with allergen that matches exclusion
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(makeTypesenseDoc({ allergens: ["latex"] }))],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "costela", excludeAllergens: ["latex"] })

      expect(result.products).toHaveLength(0)
      expect(result.noResultsReason).toBe("allergen_filtered")
      // Should NOT call Typesense a second time (diagnostic only runs when rawDocs is empty)
      expect(mockTypesenseSearch).toHaveBeenCalledTimes(1)
    })

    it("not_available_now: when availableNow=true, unavailable products are annotated isAvailableNow:false and sorted last", async () => {
      // Use impossible hours so 'almoco' window is never open
      const origStart = process.env.RESTAURANT_LUNCH_START_HOUR
      const origEnd = process.env.RESTAURANT_LUNCH_END_HOUR
      process.env.RESTAURANT_LUNCH_START_HOUR = "25"
      process.env.RESTAURANT_LUNCH_END_HOUR = "26"

      try {
        mockTypesenseSearch.mockResolvedValueOnce({
          results: [{
            hits: [makeHit(makeTypesenseDoc({ availabilityWindow: "almoco", allergens: [] }))],
            found: 1,
          }],
        })

        const result = await searchProducts({ query: "costela", availableNow: true })

        // Availability no longer excludes products — they are annotated and sorted last
        expect(result.products).toHaveLength(1)
        expect((result.products[0] as { isAvailableNow?: boolean }).isAvailableNow).toBe(false)
        // noResultsReason is absent because products ARE returned (just unavailable)
        expect(result.noResultsReason).toBeUndefined()
      } finally {
        process.env.RESTAURANT_LUNCH_START_HOUR = origStart
        process.env.RESTAURANT_LUNCH_END_HOUR = origEnd
      }
    })

    it("absent when products are found", async () => {
      const result = await searchProducts({ query: "costela" })

      expect(result.products.length).toBeGreaterThan(0)
      expect(result.noResultsReason).toBeUndefined()
    })

    it("absent on cache hit (no diagnostic needed for cached results)", async () => {
      vi.mocked(getExactQueryCache).mockResolvedValueOnce({
        hit: true,
        results: [],
        cachedAt: new Date().toISOString(),
      })

      const result = await searchProducts({ query: "costela" })

      // Cache hit returns empty — but no diagnostic pass
      expect(result.hitCache).toBe(true)
      expect(result.noResultsReason).toBeUndefined()
    })
  })

  // ── Multi-query (queries[]) ──────────────────────────────────────────────────

  describe("queries[]", () => {
    it("runs parallel searches and returns queriesResults with per-query breakdown", async () => {
      const porkDoc = makeTypesenseDoc({ id: "pork_1", title: "Costela de Porco" })
      const beefDoc = makeTypesenseDoc({ id: "beef_1", title: "Costela de Boi" })

      // First query: costela de porco
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(porkDoc, 0.9)],
          found: 1,
        }],
      })
      // Second query: costela de boi
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(beefDoc, 0.8)],
          found: 1,
        }],
      })

      const result = await searchProducts({
        queries: ["costela de porco", "costela de boi"],
      })

      expect(mockTypesenseSearch).toHaveBeenCalledTimes(2)
      expect(result.products).toHaveLength(2)
      expect(result.queriesResults).toHaveLength(2)
      expect(result.queriesResults![0].query).toBe("costela de porco")
      expect(result.queriesResults![0].products[0].id).toBe("pork_1")
      expect(result.queriesResults![1].query).toBe("costela de boi")
      expect(result.queriesResults![1].products[0].id).toBe("beef_1")
    })

    it("deduplicates products that appear in multiple queries — first occurrence wins", async () => {
      const sharedDoc = makeTypesenseDoc({ id: "shared_1", title: "Costela Mista" })
      const porkOnlyDoc = makeTypesenseDoc({ id: "pork_only", title: "Costelinha Suína" })

      // First query: returns shared + pork-only
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(sharedDoc, 0.95), makeHit(porkOnlyDoc, 0.7)],
          found: 2,
        }],
      })
      // Second query: returns shared again (same product)
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(sharedDoc, 0.6)],
          found: 1,
        }],
      })

      const result = await searchProducts({
        queries: ["costela de porco", "costela mista"],
      })

      // shared_1 should appear only once; total 2 unique products
      const ids = result.products.map((p) => p.id)
      expect(ids).toContain("shared_1")
      expect(ids).toContain("pork_only")
      expect(ids.filter((id) => id === "shared_1")).toHaveLength(1)
      expect(result.products).toHaveLength(2)
    })

    it("totalFound is the sum of all per-query Typesense found counts", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [makeHit(makeTypesenseDoc({ id: "a" }))], found: 5 }] })
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [makeHit(makeTypesenseDoc({ id: "b" }))], found: 3 }] })

      const result = await searchProducts({ queries: ["porco", "boi"] })

      expect(result.totalFound).toBe(8) // 5 + 3
    })

    it("scores contain all unique products from all queries", async () => {
      const porkDoc = makeTypesenseDoc({ id: "pork_1" })
      const beefDoc = makeTypesenseDoc({ id: "beef_1" })

      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [makeHit(porkDoc, 0.9)], found: 1 }] })
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [makeHit(beefDoc, 0.7)], found: 1 }] })

      const result = await searchProducts({ queries: ["porco", "boi"] })

      expect(result.scores).toBeDefined()
      expect(result.scores!["pork_1"]).toBeCloseTo(0.9, 2)
      expect(result.scores!["beef_1"]).toBeCloseTo(0.7, 2)
    })

    it("queriesResults absent when single query is used", async () => {
      const result = await searchProducts({ query: "costela" })

      expect(result.queriesResults).toBeUndefined()
    })

    it("per-query noResultsReason in queriesResults when a query has no results", async () => {
      const porkDoc = makeTypesenseDoc({ id: "pork_1" })

      // First query: finds product
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [makeHit(porkDoc, 0.9)], found: 1 }] })
      // Second query: empty primary + empty diagnostic = no_match
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [], found: 0 }] })
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [], found: 0 }] }) // diagnostic call

      const result = await searchProducts({
        queries: ["costela de porco", "produto xyz"],
      })

      expect(result.queriesResults![0].products).toHaveLength(1)
      expect(result.queriesResults![0].noResultsReason).toBeUndefined()
      expect(result.queriesResults![1].products).toHaveLength(0)
      expect(result.queriesResults![1].noResultsReason).toBe("no_match")
    })
  })

  // ── Mapper correctness (Bug 6 regression) ───────────────────────────────────

  describe("typesenseDocToDTO mapping", () => {
    it("reads price from flat Typesense price field — not nested variants (Bug 6)", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(makeTypesenseDoc({ price: 8900 }))],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "costela" })

      // Must be 8900, not 0 (the old bug: read variants[0].prices[0].amount from flat doc)
      expect(result.products[0].price).toBe(8900)
    })

    it("reads allergens from flat Typesense allergens field — not metadata.allergens", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(makeTypesenseDoc({ allergens: ["gluten", "lactose"] }))],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "algo" })

      expect(result.products[0].allergens).toEqual(["gluten", "lactose"])
    })

    it("reads tags from flat Typesense tags field — not tag_ids", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(makeTypesenseDoc({ tags: ["popular", "sem_gluten"] }))],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "algo" })

      expect(result.products[0].tags).toEqual(["popular", "sem_gluten"])
    })

    it("defaults allergens to [] when field is absent — always an explicit array (CLAUDE.md rule)", async () => {
      const docWithoutAllergens = makeTypesenseDoc()
      delete (docWithoutAllergens as Record<string, unknown>).allergens

      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(docWithoutAllergens)],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "algo" })

      expect(Array.isArray(result.products[0].allergens)).toBe(true)
      expect(result.products[0].allergens).toHaveLength(0)
    })

    it("maps status and inStock from flat Typesense fields", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(makeTypesenseDoc({ status: "published", inStock: true }))],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "algo" })

      expect(result.products[0].status).toBe("published")
      expect(result.products[0].inStock).toBe(true)
    })
  })

  // ── Post-fetch filters ───────────────────────────────────────────────────────

  describe("applyFilters", () => {
    it("excludes products with allergens listed in excludeAllergens", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [
            makeHit(makeTypesenseDoc({ id: "prod_1", allergens: ["latex"] })),
            makeHit(makeTypesenseDoc({ id: "prod_2", allergens: [] })),
          ],
          found: 2,
        }],
      })

      const result = await searchProducts({
        query: "costela",
        excludeAllergens: ["latex"],
      })

      expect(result.products).toHaveLength(1)
      expect(result.products[0].id).toBe("prod_2")
    })

    it("keeps products with no allergens when excludeAllergens is set", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [makeHit(makeTypesenseDoc({ allergens: [] }))],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "algo", excludeAllergens: ["latex"] })

      expect(result.products).toHaveLength(1)
    })

    it("filters by tags — product must contain at least one requested tag", async () => {
      // Tags are now sent to Typesense via filter_by, so Typesense does the filtering.
      // Mock returns only the matching product (as Typesense would).
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [
            makeHit(makeTypesenseDoc({ id: "prod_1", tags: ["carne", "popular"] })),
          ],
          found: 1,
        }],
      })

      const result = await searchProducts({ query: "algo", tags: ["carne"] })

      // Verify tags clause is in filter_by sent to Typesense
      const args = mockTypesenseSearch.mock.calls[0][0].searches[0]
      expect(args.filter_by).toContain("tags:=[carne]")
      expect(result.products).toHaveLength(1)
      expect(result.products[0].id).toBe("prod_1")
    })

    it("returns all products when no tags filter is specified", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [
            makeHit(makeTypesenseDoc({ id: "prod_1", tags: ["carne"] })),
            makeHit(makeTypesenseDoc({ id: "prod_2", tags: ["sobremesa"] })),
          ],
          found: 2,
        }],
      })

      const result = await searchProducts({ query: "algo" })

      // Verify no tags clause in filter_by when tags not specified
      const args = mockTypesenseSearch.mock.calls[0][0].searches[0]
      expect(args.filter_by).not.toContain("tags:=")
      expect(result.products).toHaveLength(2)
    })

    it("returns empty array when all products are excluded by allergen filter", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [
            makeHit(makeTypesenseDoc({ allergens: ["gluten"] })),
            makeHit(makeTypesenseDoc({ allergens: ["lactose"] })),
          ],
          found: 2,
        }],
      })

      const result = await searchProducts({
        query: "algo",
        excludeAllergens: ["gluten", "lactose"],
      })

      expect(result.products).toHaveLength(0)
    })
  })

  // ── Availability window ──────────────────────────────────────────────────────

  describe("isAvailableNow", () => {
    it("always includes congelados and sempre products regardless of current hour", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [
            makeHit(makeTypesenseDoc({ id: "a", availabilityWindow: "congelados" })),
            makeHit(makeTypesenseDoc({ id: "b", availabilityWindow: "sempre" })),
          ],
          found: 2,
        }],
      })

      const result = await searchProducts({ query: "algo", availableNow: true })

      expect(result.products).toHaveLength(2)
    })

    it("does not filter by availability when availableNow is false or absent", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [
            makeHit(makeTypesenseDoc({ id: "a", availabilityWindow: "almoco" })),
            makeHit(makeTypesenseDoc({ id: "b", availabilityWindow: "jantar" })),
          ],
          found: 2,
        }],
      })

      const result = await searchProducts({ query: "algo", availableNow: false })

      expect(result.products).toHaveLength(2)
    })
  })

  // ── Cache behavior ────────────────────────────────────────────────────────────

  describe("cache", () => {
    it("L0 exact hit: skips Typesense AND embedding generation (zero cost)", async () => {
      vi.mocked(getExactQueryCache).mockResolvedValueOnce({
        hit: true,
        results: [makeTypesenseDoc() as unknown as ProductDTO],
        cachedAt: new Date().toISOString(),
      })

      const result = await searchProducts({ query: "costela" })

      // Zero API calls — this is the whole point of L0 cache
      expect(mockTypesenseSearch).not.toHaveBeenCalled()
      expect(mockGenerateEmbedding).not.toHaveBeenCalled()
      expect(result.hitCache).toBe(true)
    })

    it("L1 semantic hit: skips Typesense but still generates embedding for bucket lookup", async () => {
      vi.mocked(getQueryCache).mockResolvedValueOnce({
        hit: true,
        results: [makeTypesenseDoc() as unknown as ProductDTO],
        cachedAt: new Date().toISOString(),
      })

      const result = await searchProducts({ query: "costela bovina" })

      expect(mockTypesenseSearch).not.toHaveBeenCalled()
      expect(result.hitCache).toBe(true)
    })

    it("sets hitCache: false on fresh Typesense search", async () => {
      const result = await searchProducts({ query: "costela" })
      expect(result.hitCache).toBe(false)
    })
  })

  // ── NATS events ───────────────────────────────────────────────────────────────

  describe("NATS search.results_viewed events", () => {
    it("publishes search.results_viewed (not product.viewed or product.searched)", async () => {
      await searchProducts({ query: "costela" })

      const calls = vi.mocked(publishNatsEvent).mock.calls
      const eventNames = calls.map((c) => c[0])
      expect(eventNames).toContain("search.results_viewed")
      expect(eventNames).not.toContain("product.viewed")
      expect(eventNames).not.toContain("product.searched")
    })

    it("emits a single batch event with all product IDs", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({
        results: [{
          hits: [
            makeHit(makeTypesenseDoc({ id: "prod_a" })),
            makeHit(makeTypesenseDoc({ id: "prod_b" })),
            makeHit(makeTypesenseDoc({ id: "prod_c" })),
          ],
          found: 3,
        }],
      })

      await searchProducts({ query: "costela" })

      const batchCalls = vi.mocked(publishNatsEvent).mock.calls
        .filter((c) => c[0] === "search.results_viewed")

      expect(batchCalls).toHaveLength(1)

      const payload = batchCalls[0][1] as { productIds: string[] }
      expect(payload.productIds).toContain("prod_a")
      expect(payload.productIds).toContain("prod_b")
      expect(payload.productIds).toContain("prod_c")
      expect(payload.productIds).toHaveLength(3)
    })

    it("event payload has correct structure", async () => {
      await searchProducts(
        { query: "costela" },
        { sessionId: "sess_123", channel: Channel.Web }
      )

      const batchCall = vi.mocked(publishNatsEvent).mock.calls
        .find((c) => c[0] === "search.results_viewed")!

      const payload = batchCall[1] as Record<string, unknown>
      expect(payload.eventType).toBe("search.results_viewed")
      expect(payload.sessionId).toBe("sess_123")
      expect(payload.channel).toBe(Channel.Web)
      expect(payload.productIds).toBeDefined()
      expect(payload.timestamp).toBeDefined()
      expect(payload.query).toBeDefined()
    })

    it("does not publish events when products array is empty", async () => {
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [], found: 0 }] })
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [], found: 0 }] }) // diagnostic

      await searchProducts({ query: "algo" })

      const batchCalls = vi.mocked(publishNatsEvent).mock.calls
        .filter((c) => c[0] === "search.results_viewed")

      expect(batchCalls).toHaveLength(0)
    })

    it("emits single event with only UNIQUE products when queries[] used (deduped)", async () => {
      const sharedDoc = makeTypesenseDoc({ id: "shared_1" })
      const uniqueDoc = makeTypesenseDoc({ id: "unique_1" })

      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [makeHit(sharedDoc), makeHit(uniqueDoc)], found: 2 }] })
      mockTypesenseSearch.mockResolvedValueOnce({ results: [{ hits: [makeHit(sharedDoc)], found: 1 }] })

      await searchProducts({ queries: ["porco", "boi"] })

      const batchCalls = vi.mocked(publishNatsEvent).mock.calls
        .filter((c) => c[0] === "search.results_viewed")

      expect(batchCalls).toHaveLength(1)

      const payload = batchCalls[0][1] as { productIds: string[] }
      // shared_1 is in both queries but merged output has it only once
      expect(payload.productIds.filter((id: string) => id === "shared_1")).toHaveLength(1)
      expect(payload.productIds).toContain("unique_1")
      expect(payload.productIds).toHaveLength(2)
    })
  })

  // ── Tool definition ──────────────────────────────────────────────────────────

  describe("SearchProductsTool", () => {
    it("has name: search_products", () => {
      expect(SearchProductsTool.name).toBe("search_products")
    })

    it("has both query and queries optional parameters", () => {
      const { properties } = SearchProductsTool.inputSchema
      expect(properties.query).toBeDefined()
      expect(properties.queries).toBeDefined()
    })

    it("has no required array (both query and queries are optional — Zod refine enforces one)", () => {
      expect((SearchProductsTool.inputSchema as Record<string, unknown>).required).toBeUndefined()
    })

    it("has all expected optional parameters in schema", () => {
      const { properties } = SearchProductsTool.inputSchema
      expect(properties.limit).toBeDefined()
      expect(properties.tags).toBeDefined()
      expect(properties.availableNow).toBeDefined()
      expect(properties.excludeAllergens).toBeDefined()
    })
  })
})
