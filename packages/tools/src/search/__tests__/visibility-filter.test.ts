// Tests for channel visibility post-filter in searchProducts
// Mock-based; no database or network required.
//
// Scenarios:
// - channel="whatsapp": returns "all" and "whatsapp" products, excludes "web" and "staff"
// - channel="web": returns "all" and "web" products, excludes "whatsapp" and "staff"
// - no channel: returns only "all" products
// - products without visibility metadata treated as "all"

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockTypesenseSearch = vi.hoisted(() => vi.fn())
const mockGenerateEmbedding = vi.hoisted(() => vi.fn())

// ── Module mocks ──────────────────────────────────────────────────────────────

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

// ── Imports ───────────────────────────────────────────────────────────────────

import { searchProducts } from "../search-products.js"
import { Channel } from "@ibatexas/types"
import type { AgentContext } from "@ibatexas/types"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_EMBEDDING = Array(1536).fill(0.1)

const makeDoc = (id: string, visibility?: string) => ({
  id,
  title: `Produto ${id}`,
  description: "",
  price: 5000,
  imageUrl: null,
  tags: [],
  availabilityWindow: "sempre",
  allergens: [],
  productType: "food",
  status: "published",
  inStock: true,
  ...(visibility !== undefined ? { visibility } : {}),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdAtTimestamp: Date.now(),
})

const makeHit = (doc: Record<string, unknown>) => ({
  document: doc,
  hybrid_search_info: { rank_fusion_score: 0.9 },
  text_match_score: 0.9,
})

function makeCtx(channel: Channel): AgentContext {
  return {
    channel,
    sessionId: "sess_visibility_test",
    userType: "customer",
  }
}

const ALL_DOCS = [
  makeDoc("prod_all", "all"),
  makeDoc("prod_whatsapp", "whatsapp"),
  makeDoc("prod_web", "web"),
  makeDoc("prod_staff", "staff"),
]

function mockTypesenseWithDocs(docs: ReturnType<typeof makeDoc>[]) {
  mockTypesenseSearch.mockResolvedValue({
    results: [{
      hits: docs.map(makeHit),
      found: docs.length,
    }],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("channel visibility post-filter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateEmbedding.mockResolvedValue(TEST_EMBEDDING)
  })

  it("channel=whatsapp: returns 'all' and 'whatsapp' products", async () => {
    mockTypesenseWithDocs(ALL_DOCS)

    const result = await searchProducts({ query: "produto" }, makeCtx(Channel.WhatsApp))

    const ids = result.products.map((p) => p.id)
    expect(ids).toContain("prod_all")
    expect(ids).toContain("prod_whatsapp")
  })

  it("channel=whatsapp: excludes 'web' and 'staff' products", async () => {
    mockTypesenseWithDocs(ALL_DOCS)

    const result = await searchProducts({ query: "produto" }, makeCtx(Channel.WhatsApp))

    const ids = result.products.map((p) => p.id)
    expect(ids).not.toContain("prod_web")
    expect(ids).not.toContain("prod_staff")
  })

  it("channel=web: returns 'all' and 'web' products", async () => {
    mockTypesenseWithDocs(ALL_DOCS)

    const result = await searchProducts({ query: "produto" }, makeCtx(Channel.Web))

    const ids = result.products.map((p) => p.id)
    expect(ids).toContain("prod_all")
    expect(ids).toContain("prod_web")
  })

  it("channel=web: excludes 'whatsapp' and 'staff' products", async () => {
    mockTypesenseWithDocs(ALL_DOCS)

    const result = await searchProducts({ query: "produto" }, makeCtx(Channel.Web))

    const ids = result.products.map((p) => p.id)
    expect(ids).not.toContain("prod_whatsapp")
    expect(ids).not.toContain("prod_staff")
  })

  it("no context (defaults to web channel): returns 'all' and 'web' products, excludes whatsapp and staff", async () => {
    mockTypesenseWithDocs(ALL_DOCS)

    // searchProducts defaults channel to Channel.Web when no context is provided
    const result = await searchProducts({ query: "produto" })

    const ids = result.products.map((p) => p.id)
    expect(ids).toContain("prod_all")
    expect(ids).toContain("prod_web")
    expect(ids).not.toContain("prod_whatsapp")
    expect(ids).not.toContain("prod_staff")
  })

  it("products without visibility field are treated as 'all'", async () => {
    const docWithoutVisibility = makeDoc("prod_no_visibility")
    // Ensure the visibility key is absent (not just undefined)
    delete (docWithoutVisibility as Record<string, unknown>).visibility
    mockTypesenseWithDocs([docWithoutVisibility])

    const result = await searchProducts({ query: "produto" }, makeCtx(Channel.Web))

    const ids = result.products.map((p) => p.id)
    expect(ids).toContain("prod_no_visibility")
  })

  it("products without visibility field visible on whatsapp channel", async () => {
    const docWithoutVisibility = makeDoc("prod_no_visibility")
    delete (docWithoutVisibility as Record<string, unknown>).visibility
    mockTypesenseWithDocs([docWithoutVisibility])

    const result = await searchProducts({ query: "produto" }, makeCtx(Channel.WhatsApp))

    const ids = result.products.map((p) => p.id)
    expect(ids).toContain("prod_no_visibility")
  })
})
