/**
 * Unit tests: Product Indexing Subscribers
 *
 * Tests the three Medusa v2 subscriber handlers in isolation.
 * All external dependencies (Typesense, Redis, NATS) are mocked.
 *
 * Design rules verified:
 * - product.created: indexes product, does NOT invalidate cache
 * - product.updated: indexes product + flushes entire query cache
 * - product.deleted: removes from index + flushes cache + deletes embedding
 * - Errors do not propagate (indexing must not block Medusa lifecycle)
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mocks must be declared before imports ─────────────────────────────────────

vi.mock("@ibatexas/tools", () => ({
  indexProduct: vi.fn().mockResolvedValue(undefined),
  deleteProductFromIndex: vi.fn().mockResolvedValue(undefined),
  invalidateAllQueryCache: vi.fn().mockResolvedValue(3),
  deleteEmbeddingCache: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn().mockResolvedValue(undefined),
}))

// Provide minimal stubs for Medusa framework imports
vi.mock("@medusajs/framework", () => ({}))
vi.mock("@medusajs/framework/utils", () => ({
  Modules: { PRODUCT: "product" },
}))

// ── Imports after mocks ────────────────────────────────────────────────────────

import productCreatedHandler from "../src/subscribers/product-created.js"
import productUpdatedHandler from "../src/subscribers/product-updated.js"
import productDeletedHandler from "../src/subscribers/product-deleted.js"

import {
  indexProduct,
  deleteProductFromIndex,
  invalidateAllQueryCache,
  deleteEmbeddingCache,
} from "@ibatexas/tools"

import { publishNatsEvent } from "@ibatexas/nats-client"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockProduct = {
  id: "prod_costela_01",
  title: "Costela Bovina Defumada",
  description: "Costela premium defumada lentamente",
  status: "published",
  metadata: {
    allergens: ["latex"],
    availabilityWindow: "almoco",
    inStock: true,
  },
  variants: [{ id: "var_1", prices: [{ amount: 8900 }] }],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

/**
 * Create a minimal Medusa DI container mock.
 * Resolves "logger" and any module key to the provided product service.
 */
function makeContainer(product = mockProduct) {
  const productService = {
    retrieveProduct: vi.fn().mockResolvedValue(product),
  }
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }
  return {
    resolve: vi.fn().mockImplementation((key: string) => {
      if (key === "logger") return logger
      // Return productService for any module key (Modules.PRODUCT, etc.)
      return productService
    }),
    _productService: productService, // expose for assertion
    _logger: logger,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Product Indexing Subscribers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── product.created ──────────────────────────────────────────────────────────

  describe("productCreatedHandler (product.created)", () => {
    it("calls indexProduct with the retrieved product", async () => {
      const container = makeContainer()

      await productCreatedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(indexProduct).toHaveBeenCalledOnce()
      expect(indexProduct).toHaveBeenCalledWith(mockProduct)
    })

    it("does NOT call invalidateAllQueryCache — new products don't stale existing results", async () => {
      const container = makeContainer()

      await productCreatedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(invalidateAllQueryCache).not.toHaveBeenCalled()
    })

    it("does NOT call deleteEmbeddingCache (no prior embedding to purge)", async () => {
      const container = makeContainer()

      await productCreatedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(deleteEmbeddingCache).not.toHaveBeenCalled()
    })

    it("publishes product.indexed NATS event with action=created", async () => {
      const container = makeContainer()

      await productCreatedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(publishNatsEvent).toHaveBeenCalledWith(
        "product.indexed",
        expect.objectContaining({
          productId: mockProduct.id,
          action: "created",
          title: mockProduct.title,
        })
      )
    })

    it("does not throw when indexProduct fails — indexing must not block Medusa", async () => {
      const container = makeContainer()
      ;(indexProduct as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Typesense unavailable")
      )

      await expect(
        productCreatedHandler({
          event: { data: { id: mockProduct.id } },
          container,
        } as any)
      ).resolves.toBeUndefined()
    })
  })

  // ── product.updated ──────────────────────────────────────────────────────────

  describe("productUpdatedHandler (product.updated)", () => {
    it("calls indexProduct with the retrieved product", async () => {
      const container = makeContainer()

      await productUpdatedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(indexProduct).toHaveBeenCalledOnce()
      expect(indexProduct).toHaveBeenCalledWith(mockProduct)
    })

    it("calls invalidateAllQueryCache — admin change must be reflected immediately", async () => {
      const container = makeContainer()

      await productUpdatedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(invalidateAllQueryCache).toHaveBeenCalledOnce()
    })

    it("calls deleteEmbeddingCache to force re-embedding on next index", async () => {
      const container = makeContainer()

      await productUpdatedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(deleteEmbeddingCache).toHaveBeenCalledWith(mockProduct.id)
    })

    it("publishes product.indexed NATS event with action=updated", async () => {
      const container = makeContainer()

      await productUpdatedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(publishNatsEvent).toHaveBeenCalledWith(
        "product.indexed",
        expect.objectContaining({
          productId: mockProduct.id,
          action: "updated",
        })
      )
    })

    it("does not throw when indexProduct fails", async () => {
      const container = makeContainer()
      ;(indexProduct as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Typesense unavailable")
      )

      await expect(
        productUpdatedHandler({
          event: { data: { id: mockProduct.id } },
          container,
        } as any)
      ).resolves.toBeUndefined()
    })
  })

  // ── product.deleted ──────────────────────────────────────────────────────────

  describe("productDeletedHandler (product.deleted)", () => {
    it("calls deleteProductFromIndex with the product ID", async () => {
      const container = makeContainer()

      await productDeletedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(deleteProductFromIndex).toHaveBeenCalledWith(mockProduct.id)
    })

    it("calls invalidateAllQueryCache — deleted products must not appear in search", async () => {
      const container = makeContainer()

      await productDeletedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(invalidateAllQueryCache).toHaveBeenCalledOnce()
    })

    it("calls deleteEmbeddingCache with the product ID", async () => {
      const container = makeContainer()

      await productDeletedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(deleteEmbeddingCache).toHaveBeenCalledWith(mockProduct.id)
    })

    it("does NOT call indexProduct (delete, not re-index)", async () => {
      const container = makeContainer()

      await productDeletedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(indexProduct).not.toHaveBeenCalled()
    })

    it("publishes product.indexed NATS event with action=deleted", async () => {
      const container = makeContainer()

      await productDeletedHandler({
        event: { data: { id: mockProduct.id } },
        container,
      } as any)

      expect(publishNatsEvent).toHaveBeenCalledWith(
        "product.indexed",
        expect.objectContaining({
          productId: mockProduct.id,
          action: "deleted",
        })
      )
    })

    it("does not throw when deleteProductFromIndex fails (idempotent)", async () => {
      const container = makeContainer()
      ;(deleteProductFromIndex as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Typesense unavailable")
      )

      await expect(
        productDeletedHandler({
          event: { data: { id: mockProduct.id } },
          container,
        } as any)
      ).resolves.toBeUndefined()
    })
  })
})
