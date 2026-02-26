// Tests for get-product-details tool
// Covers: happy path, 404 returns null, non-404 rethrows

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ProductDTO } from "@ibatexas/types"

const mockRetrieve = vi.hoisted(() => vi.fn())
const mockTypesenseDocToDTO = vi.hoisted(() =>
  vi.fn((doc: { id: string; title: string }): ProductDTO => ({
    id: doc.id,
    title: doc.title,
    description: "",
    price: 5000,
    imageUrl: null,
    images: [],
    tags: [],
    allergens: [],
    variants: [],
    availabilityWindow: "always" as unknown as ProductDTO["availabilityWindow"],
    productType: "food" as unknown as ProductDTO["productType"],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
  })),
)

// Mock getProductDetails' dependencies
// Source imports ../typesense/client.js from catalog/ level
// From catalog/__tests__/ that's ../../typesense/client.js
vi.mock("../../typesense/client.js", () => ({
  getTypesenseClient: () => ({
    collections: (name: string) => ({
      documents: (id: string) => ({
        retrieve: mockRetrieve,
      }),
    }),
  }),
  COLLECTION: "products",
}))

vi.mock("../../mappers/product-mapper.js", () => ({
  typesenseDocToDTO: mockTypesenseDocToDTO,
}))

import { getProductDetails } from "../get-product-details.js"

describe("getProductDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns ProductDTO for existing product", async () => {
    mockRetrieve.mockResolvedValue({ id: "prod_01", title: "Costela Defumada" })

    const result = await getProductDetails("prod_01")

    expect(result).toBeDefined()
    expect(result!.id).toBe("prod_01")
    expect(result!.title).toBe("Costela Defumada")
  })

  it("returns null for 404 (product not found)", async () => {
    mockRetrieve.mockRejectedValue({ httpStatus: 404, message: "Not Found" })

    const result = await getProductDetails("nonexistent")
    expect(result).toBeNull()
  })

  it("rethrows non-404 errors (e.g., 500 server error)", async () => {
    const serverError = { httpStatus: 500, message: "Internal Server Error" }
    mockRetrieve.mockRejectedValue(serverError)

    await expect(getProductDetails("prod_01")).rejects.toEqual(serverError)
  })

  it("rethrows network errors", async () => {
    mockRetrieve.mockRejectedValue(new Error("ECONNREFUSED"))

    await expect(getProductDetails("prod_01")).rejects.toThrow("ECONNREFUSED")
  })
})
