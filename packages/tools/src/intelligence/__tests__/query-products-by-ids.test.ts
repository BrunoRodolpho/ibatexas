// Tests for queryProductsByIds helper
// Mock-based; no network required.
//
// Scenarios:
// - Empty array returns empty
// - Returns mapped product summaries from Typesense
// - Filters string includes all productIds
// - Price defaults to 0 when missing
// - imageUrl is undefined when null

import { describe, it, expect, beforeEach, vi } from "vitest"
import { queryProductsByIds } from "../query-products-by-ids.js"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockSearch = vi.hoisted(() => vi.fn())
const mockGetTypesenseClient = vi.hoisted(() => vi.fn())

vi.mock("../../typesense/client.js", () => ({
  getTypesenseClient: mockGetTypesenseClient,
  COLLECTION: "products",
}))

// -- Fixtures ─────────────────────────────────────────────────────────────────

const PRODUCT_DOC_A = {
  id: "prod_01",
  title: "Costela Bovina Defumada",
  price: 8900,
  imageUrl: "https://img.test/costela.jpg",
}

const PRODUCT_DOC_B = {
  id: "prod_02",
  title: "Brisket Angus",
  price: 12900,
  imageUrl: null,
}

const PRODUCT_DOC_NO_PRICE = {
  id: "prod_03",
  title: "Molho Especial",
  price: undefined,
  imageUrl: null,
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("queryProductsByIds", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTypesenseClient.mockReturnValue({
      collections: () => ({
        documents: () => ({
          search: mockSearch,
        }),
      }),
    })
  })

  it("returns empty array for empty productIds input", async () => {
    const result = await queryProductsByIds([], 10)

    expect(result).toEqual([])
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it("returns mapped product summaries on happy path", async () => {
    mockSearch.mockResolvedValue({
      hits: [{ document: PRODUCT_DOC_A }, { document: PRODUCT_DOC_B }],
    })

    const result = await queryProductsByIds(["prod_01", "prod_02"], 10)

    expect(result).toEqual([
      {
        id: "prod_01",
        title: "Costela Bovina Defumada",
        price: 8900,
        imageUrl: "https://img.test/costela.jpg",
      },
      {
        id: "prod_02",
        title: "Brisket Angus",
        price: 12900,
        imageUrl: undefined,
      },
    ])
  })

  it("builds filter_by with all product IDs joined", async () => {
    mockSearch.mockResolvedValue({ hits: [] })

    await queryProductsByIds(["prod_01", "prod_02", "prod_03"], 5)

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        filter_by: "id:[prod_01,prod_02,prod_03] && inStock:=true && published:=true",
        per_page: 5,
      }),
    )
  })

  it("defaults price to 0 when missing from document", async () => {
    mockSearch.mockResolvedValue({
      hits: [{ document: PRODUCT_DOC_NO_PRICE }],
    })

    const result = await queryProductsByIds(["prod_03"], 5)

    expect(result[0].price).toBe(0)
  })

  it("sets imageUrl to undefined when null", async () => {
    mockSearch.mockResolvedValue({
      hits: [{ document: PRODUCT_DOC_B }],
    })

    const result = await queryProductsByIds(["prod_02"], 5)

    expect(result[0].imageUrl).toBeUndefined()
  })

  it("returns empty array when hits is null", async () => {
    mockSearch.mockResolvedValue({ hits: null })

    const result = await queryProductsByIds(["prod_01"], 5)

    expect(result).toEqual([])
  })
})
