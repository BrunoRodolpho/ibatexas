// Tests for Typesense product indexing
// Mock-based; no Typesense or network required.
//
// Critical regressions tested:
// - indexProduct generates embedding and includes it in the document (Bug 7)
// - indexProductsBatch uses .import() not .upsert() on array (Bug 4)
// - Embedding failure still indexes product for keyword search (graceful degradation)
// - deleteProductFromIndex ignores 404 (idempotent delete)

import { describe, it, expect, beforeEach, vi } from "vitest"
import { indexProduct, deleteProductFromIndex, indexProductsBatch } from "../index-product.js"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockUpsert = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const mockImport = vi.hoisted(() =>
  vi.fn().mockResolvedValue([{ success: true }, { success: true }])
)
const mockDelete = vi.hoisted(() => vi.fn().mockResolvedValue({}))

vi.mock("../client.js", () => ({
  getTypesenseClient: vi.fn(() => ({
    collections: vi.fn(() => ({
      documents: vi.fn((docId?: string) => {
        if (docId !== undefined) {
          // documents("prod_id") → single document → .delete()
          return { delete: mockDelete }
        }
        // documents() → collection → .upsert() / .import()
        return { upsert: mockUpsert, import: mockImport }
      }),
    })),
  })),
  ensureCollectionExists: vi.fn(),
  recreateCollection: vi.fn(),
  PRODUCTS_COLLECTION_SCHEMA: {},
  COLLECTION: "products",
}))

// Note: generateEmbedding is injected via deps parameter — no need to mock the module.
// We pass mock embedding functions directly to indexProduct() and indexProductsBatch().

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockMedusaProduct = {
  id: "prod_costela_01",
  title: "Costela Bovina Defumada",
  description: "Costela premium defumada lentamente por 8 horas",
  status: "published",
  handle: "costela-bovina-defumada",
  tag_ids: ["tag_popular", "tag_carne"],
  metadata: {
    allergens: ["latex"],
    availabilityWindow: "almoco",
    productType: "food",
    inStock: true,
  },
  // Medusa v2 stores in reais (89 reais = R$89.00 → 8900 centavos after conversion)
  variants: [{ id: "var_1", title: "Padrão", prices: [{ amount: 89, currency_code: "BRL" }] }],
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-15T12:00:00.000Z",
}

const TEST_EMBEDDING = Array(1536).fill(0.25)

const mockGenerateEmbedding = vi.fn().mockResolvedValue(TEST_EMBEDDING)
const mockGenerateEmbeddingFailing = vi.fn().mockRejectedValue(new Error("OpenAI rate limited"))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("indexProduct", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpsert.mockResolvedValue({})
    mockImport.mockResolvedValue([{ success: true }])
    mockDelete.mockResolvedValue({})
  })

  describe("embedding injection (Bug 7 regression)", () => {
    it("generates embedding and includes it in the Typesense document", async () => {
      await indexProduct(mockMedusaProduct, { generateEmbedding: mockGenerateEmbedding })

      expect(mockGenerateEmbedding).toHaveBeenCalledOnce()
      // Embedding text must combine title + description
      const [embeddingText] = mockGenerateEmbedding.mock.calls[0]
      expect(embeddingText).toContain(mockMedusaProduct.title)
      expect(embeddingText).toContain(mockMedusaProduct.description)

      // The upserted document must include the embedding array
      expect(mockUpsert).toHaveBeenCalledOnce()
      const upsertedDoc = mockUpsert.mock.calls[0][0]
      expect(upsertedDoc.embedding).toEqual(TEST_EMBEDDING)
    })

    it("indexes product without embedding when generation fails (keyword search fallback)", async () => {
      await indexProduct(mockMedusaProduct, {
        generateEmbedding: mockGenerateEmbeddingFailing,
      })

      // Upsert must still be called (product is indexed for keyword search)
      expect(mockUpsert).toHaveBeenCalledOnce()

      // Embedding field should be absent or undefined (not null/empty array)
      const upsertedDoc = mockUpsert.mock.calls[0][0]
      expect(upsertedDoc.embedding).toBeUndefined()
    })

    it("does not throw when embedding generation fails", async () => {
      await expect(
        indexProduct(mockMedusaProduct, { generateEmbedding: mockGenerateEmbeddingFailing })
      ).resolves.toBeUndefined()
    })
  })

  describe("document mapping", () => {
    it("maps price from variants[0].prices[0].amount", async () => {
      await indexProduct(mockMedusaProduct, { generateEmbedding: mockGenerateEmbedding })

      const doc = mockUpsert.mock.calls[0][0]
      expect(doc.price).toBe(8900)
    })

    it("sets status from product.status", async () => {
      await indexProduct(mockMedusaProduct, { generateEmbedding: mockGenerateEmbedding })

      const doc = mockUpsert.mock.calls[0][0]
      expect(doc.status).toBe("published")
    })

    it("sets inStock from metadata.inStock", async () => {
      await indexProduct(mockMedusaProduct, { generateEmbedding: mockGenerateEmbedding })

      const doc = mockUpsert.mock.calls[0][0]
      expect(doc.inStock).toBe(true)
    })

    it("defaults inStock to true when metadata.inStock is absent", async () => {
      const productWithoutInStock = {
        ...mockMedusaProduct,
        metadata: { ...mockMedusaProduct.metadata },
      }
      delete (productWithoutInStock.metadata as Record<string, unknown>).inStock

      await indexProduct(productWithoutInStock, { generateEmbedding: mockGenerateEmbedding })

      const doc = mockUpsert.mock.calls[0][0]
      expect(doc.inStock).toBe(true)
    })

    it("sets inStock to false when metadata.inStock = false (out-of-stock)", async () => {
      const outOfStock = {
        ...mockMedusaProduct,
        metadata: { ...mockMedusaProduct.metadata, inStock: false },
      }

      await indexProduct(outOfStock, { generateEmbedding: mockGenerateEmbedding })

      const doc = mockUpsert.mock.calls[0][0]
      expect(doc.inStock).toBe(false)
    })

    it("populates allergens as explicit array (CLAUDE.md rule — never inferred)", async () => {
      await indexProduct(mockMedusaProduct, { generateEmbedding: mockGenerateEmbedding })

      const doc = mockUpsert.mock.calls[0][0]
      expect(Array.isArray(doc.allergens)).toBe(true)
      expect(doc.allergens).toEqual(["latex"])
    })

    it("includes createdAtTimestamp as numeric int64 (required for Typesense sorting)", async () => {
      await indexProduct(mockMedusaProduct, { generateEmbedding: mockGenerateEmbedding })

      const doc = mockUpsert.mock.calls[0][0]
      expect(typeof doc.createdAtTimestamp).toBe("number")
      expect(Number.isInteger(doc.createdAtTimestamp)).toBe(true)
    })
  })
})

// ── indexProductsBatch ────────────────────────────────────────────────────────

describe("indexProductsBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockImport.mockResolvedValue([{ success: true }, { success: true }])
  })

  it("uses .import() not .upsert() for batch indexing (Bug 4 regression)", async () => {
    const products = [mockMedusaProduct, { ...mockMedusaProduct, id: "prod_2" }]

    await indexProductsBatch(products, { generateEmbedding: mockGenerateEmbedding })

    // import() must be called (not upsert with an array)
    expect(mockImport).toHaveBeenCalledOnce()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("calls import() with { action: 'upsert' } option", async () => {
    const products = [mockMedusaProduct]

    await indexProductsBatch(products, { generateEmbedding: mockGenerateEmbedding })

    const [, options] = mockImport.mock.calls[0]
    expect(options).toEqual({ action: "upsert" })
  })

  it("imports all products in a single request", async () => {
    const products = [
      mockMedusaProduct,
      { ...mockMedusaProduct, id: "prod_2" },
      { ...mockMedusaProduct, id: "prod_3" },
    ]

    await indexProductsBatch(products, { generateEmbedding: mockGenerateEmbedding })

    const [docs] = mockImport.mock.calls[0]
    expect(docs).toHaveLength(3)
  })

  it("includes embeddings for all products in the batch", async () => {
    const products = [mockMedusaProduct, { ...mockMedusaProduct, id: "prod_2" }]

    await indexProductsBatch(products, { generateEmbedding: mockGenerateEmbedding })

    const [docs] = mockImport.mock.calls[0]
    expect(docs[0].embedding).toEqual(TEST_EMBEDDING)
    expect(docs[1].embedding).toEqual(TEST_EMBEDDING)
  })

  it("skips embedding for individual products that fail (non-blocking batch)", async () => {
    // First product: embedding fails; second: succeeds
    const embeddingFnPartialFail = vi
      .fn()
      .mockRejectedValueOnce(new Error("Rate limited"))
      .mockResolvedValueOnce(TEST_EMBEDDING)

    const products = [mockMedusaProduct, { ...mockMedusaProduct, id: "prod_2" }]

    await indexProductsBatch(products, { generateEmbedding: embeddingFnPartialFail })

    // Both should still be imported
    const [docs] = mockImport.mock.calls[0]
    expect(docs).toHaveLength(2)
    // First has no embedding, second does
    expect(docs[0].embedding).toBeUndefined()
    expect(docs[1].embedding).toEqual(TEST_EMBEDDING)
  })

  it("does not throw when all embeddings fail (full keyword-only batch)", async () => {
    await expect(
      indexProductsBatch([mockMedusaProduct], {
        generateEmbedding: mockGenerateEmbeddingFailing,
      })
    ).resolves.toBeUndefined()

    expect(mockImport).toHaveBeenCalledOnce()
  })
})

// ── deleteProductFromIndex ────────────────────────────────────────────────────

describe("deleteProductFromIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls delete with the product ID", async () => {
    mockDelete.mockResolvedValueOnce({})

    await deleteProductFromIndex("prod_costela_01")

    expect(mockDelete).toHaveBeenCalledOnce()
  })

  it("ignores 404 — idempotent delete (product already removed)", async () => {
    mockDelete.mockRejectedValueOnce({ httpStatus: 404 })

    await expect(deleteProductFromIndex("prod_costela_01")).resolves.toBeUndefined()
  })

  it("re-throws non-404 errors", async () => {
    mockDelete.mockRejectedValueOnce({ httpStatus: 500, message: "Internal error" })

    await expect(deleteProductFromIndex("prod_costela_01")).rejects.toMatchObject({
      httpStatus: 500,
    })
  })
})
