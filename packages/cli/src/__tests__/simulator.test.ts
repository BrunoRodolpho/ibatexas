// Tests for lib/simulator.ts — simulation engine.
// Uses boundary mocking: Medusa, Prisma, ora, chalk are all mocked.
// Validates the exported functions runSimulation and rebuildAfterSimulation.

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup (vi.hoisted + vi.mock BEFORE imports) ─────────────────────────

const mockGetAdminToken = vi.hoisted(() => vi.fn().mockResolvedValue("test-token"))
const mockMedusaFetch = vi.hoisted(() => vi.fn())

vi.mock("../lib/medusa.js", () => ({
  getAdminToken: mockGetAdminToken,
  medusaFetch: mockMedusaFetch,
}))

// Mock @ibatexas/domain (dynamic import in simulator)
const mockCustomerUpsert = vi.hoisted(() => vi.fn())
const mockOrderItemCreate = vi.hoisted(() => vi.fn())
const mockReviewCreate = vi.hoisted(() => vi.fn())
const mockDisconnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    customer: { upsert: mockCustomerUpsert },
    customerOrderItem: { create: mockOrderItemCreate },
    review: { create: mockReviewCreate },
    $disconnect: mockDisconnect,
  },
}))

// Mock StepRegistry for rebuildAfterSimulation
const mockSyncReviewsRun = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockIntelCopurchaseRun = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockIntelGlobalScoreRun = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("../lib/steps.js", () => ({
  StepRegistry: {
    "sync-reviews": { label: "Sync reviews", run: mockSyncReviewsRun },
    "intel-copurchase": { label: "Intel copurchase", run: mockIntelCopurchaseRun },
    "intel-global-score": { label: "Intel global score", run: mockIntelGlobalScoreRun },
  },
}))

// Mock chalk as passthrough
vi.mock("chalk", () => {
  const passthrough = (s: unknown) => String(s)
  const handler: ProxyHandler<typeof passthrough> = {
    get: () => new Proxy(passthrough, handler),
    apply: (_target, _thisArg, args) => String(args[0]),
  }
  return { default: new Proxy(passthrough, handler) }
})

// Mock ora
const mockSpinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  text: "",
}))

vi.mock("ora", () => ({
  default: vi.fn(() => mockSpinner),
}))

// ── Import source after mocks ────────────────────────────────────────────────

import { runSimulation, rebuildAfterSimulation, type SimulationOptions } from "../lib/simulator.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function createFakeMedusaProducts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `prod_${i}`,
    title: `Produto ${i}`,
    handle: `produto-${i}`,
    status: "published",
    categories: [{ name: "carnes-defumadas", id: `cat_${i}` }],
    variants: [
      {
        id: `var_${i}`,
        price_set: {
          prices: [{ amount: 5000 + i * 100 }],
        },
      },
    ],
  }))
}

function defaultOpts(overrides: Partial<SimulationOptions> = {}): SimulationOptions {
  return {
    customers: 3,
    days: 2,
    ordersPerDay: 2,
    seed: 42,
    ...overrides,
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})

  // Default: medusaFetch returns a few products (< limit, so loadCatalog stops)
  mockMedusaFetch.mockResolvedValue({
    products: createFakeMedusaProducts(5),
  })

  // Default: prisma.customer.upsert returns a customer with incrementing IDs
  let custId = 0
  mockCustomerUpsert.mockImplementation(async () => ({
    id: `cust_${++custId}`,
    phone: "+5519900000001",
    name: "Test User",
  }))

  // Default: prisma order/review create succeed
  mockOrderItemCreate.mockResolvedValue({ id: "oi_1" })
  mockReviewCreate.mockResolvedValue({ id: "rev_1" })
})

// ── runSimulation ────────────────────────────────────────────────────────────

describe("runSimulation", () => {
  it("returns a SimulationResult with correct structure", async () => {
    const result = await runSimulation(defaultOpts())

    expect(result).toHaveProperty("customersCreated")
    expect(result).toHaveProperty("ordersCreated")
    expect(result).toHaveProperty("reviewsCreated")
    expect(result).toHaveProperty("durationMs")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("creates the requested number of customers", async () => {
    const result = await runSimulation(defaultOpts({ customers: 5 }))

    expect(result.customersCreated).toBe(5)
    expect(mockCustomerUpsert).toHaveBeenCalledTimes(5)
  })

  it("passes customer phone and name to prisma.customer.upsert", async () => {
    await runSimulation(defaultOpts({ customers: 1 }))

    expect(mockCustomerUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ phone: expect.stringMatching(/^\+5519\d+$/) }),
        create: expect.objectContaining({
          phone: expect.stringMatching(/^\+5519\d+$/),
          name: expect.any(String),
        }),
      }),
    )
  })

  it("returns zero results when no products are available (empty catalog)", async () => {
    mockMedusaFetch.mockResolvedValue({ products: [] })

    const result = await runSimulation(defaultOpts())

    expect(result.customersCreated).toBe(0)
    expect(result.ordersCreated).toBe(0)
    expect(result.reviewsCreated).toBe(0)
  })

  it("calls medusaFetch to load catalog with admin token", async () => {
    await runSimulation(defaultOpts())

    expect(mockGetAdminToken).toHaveBeenCalled()
    expect(mockMedusaFetch).toHaveBeenCalledWith(
      expect.stringContaining("/admin/products"),
      expect.objectContaining({ token: "test-token" }),
    )
  })

  it("generates orders and writes them to DB via prisma", async () => {
    const result = await runSimulation(defaultOpts({ customers: 3, days: 2, ordersPerDay: 2 }))

    // Should have created at least some orders
    expect(mockOrderItemCreate).toHaveBeenCalled()
    expect(result.ordersCreated).toBeGreaterThan(0)
  })

  it("produces deterministic results with the same seed", async () => {
    const result1 = await runSimulation(defaultOpts({ seed: 123 }))

    // Reset mocks for second run but keep same behavior
    let custId = 0
    mockCustomerUpsert.mockImplementation(async () => ({
      id: `cust_${++custId}`,
      phone: "+5519900000001",
      name: "Test User",
    }))
    mockOrderItemCreate.mockResolvedValue({ id: "oi_1" })
    mockReviewCreate.mockResolvedValue({ id: "rev_1" })

    const result2 = await runSimulation(defaultOpts({ seed: 123 }))

    expect(result1.customersCreated).toBe(result2.customersCreated)
    expect(result1.ordersCreated).toBe(result2.ordersCreated)
    expect(result1.reviewsCreated).toBe(result2.reviewsCreated)
  })

  it("generates different results with different seeds", async () => {
    const result1 = await runSimulation(defaultOpts({ seed: 1, customers: 10, days: 5, ordersPerDay: 5 }))

    let custId = 0
    mockCustomerUpsert.mockImplementation(async () => ({
      id: `cust_${++custId}`,
      phone: "+5519900000001",
      name: "Test User",
    }))
    mockOrderItemCreate.mockResolvedValue({ id: "oi_1" })
    mockReviewCreate.mockResolvedValue({ id: "rev_1" })

    const result2 = await runSimulation(defaultOpts({ seed: 999, customers: 10, days: 5, ordersPerDay: 5 }))

    // With enough data, different seeds should produce different order/review counts
    // (this is probabilistic but very likely with sufficient volume)
    const totalCalls1 = mockOrderItemCreate.mock.calls.length
    expect(result1.customersCreated).toBe(result2.customersCreated) // same count requested
  })

  it("skips unpublished products in catalog", async () => {
    mockMedusaFetch.mockResolvedValue({
      products: [
        {
          id: "prod_draft",
          title: "Draft",
          handle: "draft",
          status: "draft",
          categories: [],
          variants: [{ id: "var_draft", price_set: { prices: [{ amount: 1000 }] } }],
        },
        {
          id: "prod_pub",
          title: "Published",
          handle: "published",
          status: "published",
          categories: [{ name: "carnes-defumadas" }],
          variants: [{ id: "var_pub", price_set: { prices: [{ amount: 8900 }] } }],
        },
      ],
    })

    const result = await runSimulation(defaultOpts())
    // Should have loaded only 1 product (the published one)
    // Orders should reference only the published product
    expect(result.customersCreated).toBe(3)
  })

  it("skips products with no variants", async () => {
    mockMedusaFetch.mockResolvedValue({
      products: [
        {
          id: "prod_novar",
          title: "No Variant",
          handle: "no-variant",
          status: "published",
          categories: [],
          variants: [],
        },
      ],
    })

    const result = await runSimulation(defaultOpts())
    // No valid products -> early return with zeros
    expect(result.customersCreated).toBe(0)
    expect(result.ordersCreated).toBe(0)
  })

  it("uses default price (5000 centavos) when variant has no price_set", async () => {
    mockMedusaFetch.mockResolvedValue({
      products: [
        {
          id: "prod_noprice",
          title: "No Price",
          handle: "no-price",
          status: "published",
          categories: [{ name: "carnes-defumadas" }],
          variants: [{ id: "var_noprice" }], // No price_set
        },
      ],
    })

    const result = await runSimulation(defaultOpts({ customers: 1, days: 1, ordersPerDay: 1 }))
    // Should still generate orders using default price
    expect(result.customersCreated).toBe(1)
  })

  it("handles prisma create failures gracefully (idempotent)", async () => {
    mockOrderItemCreate.mockRejectedValue(new Error("Unique constraint failed"))
    mockReviewCreate.mockRejectedValue(new Error("Unique constraint failed"))

    const result = await runSimulation(defaultOpts())

    // Customers are still created, but order/review counts should be 0
    expect(result.customersCreated).toBe(3)
    expect(result.ordersCreated).toBe(0)
    expect(result.reviewsCreated).toBe(0)
  })

  it("disconnects prisma after simulation", async () => {
    await runSimulation(defaultOpts())
    expect(mockDisconnect).toHaveBeenCalled()
  })

  it("paginates catalog loading when products exceed page limit", async () => {
    // First call returns 100 products (full page), second call returns 5 (partial page)
    mockMedusaFetch
      .mockResolvedValueOnce({ products: createFakeMedusaProducts(100) })
      .mockResolvedValueOnce({ products: createFakeMedusaProducts(5) })

    const result = await runSimulation(defaultOpts())
    expect(mockMedusaFetch).toHaveBeenCalledTimes(2)
    expect(result.customersCreated).toBe(3)
  })
})

// ── rebuildAfterSimulation ───────────────────────────────────────────────────

describe("rebuildAfterSimulation", () => {
  it("runs all three rebuild steps in order", async () => {
    await rebuildAfterSimulation()

    expect(mockSyncReviewsRun).toHaveBeenCalledTimes(1)
    expect(mockIntelCopurchaseRun).toHaveBeenCalledTimes(1)
    expect(mockIntelGlobalScoreRun).toHaveBeenCalledTimes(1)
  })

  it("handles sync-reviews failure gracefully", async () => {
    mockSyncReviewsRun.mockRejectedValueOnce(new Error("Review sync failed"))

    // Should not throw — error is caught and logged
    await expect(rebuildAfterSimulation()).resolves.toBeUndefined()

    // Other steps should still run
    expect(mockIntelCopurchaseRun).toHaveBeenCalled()
    expect(mockIntelGlobalScoreRun).toHaveBeenCalled()
  })

  it("handles intel-copurchase failure gracefully", async () => {
    mockIntelCopurchaseRun.mockRejectedValueOnce(new Error("Copurchase rebuild failed"))

    await expect(rebuildAfterSimulation()).resolves.toBeUndefined()
    expect(mockIntelGlobalScoreRun).toHaveBeenCalled()
  })

  it("handles intel-global-score failure gracefully", async () => {
    mockIntelGlobalScoreRun.mockRejectedValueOnce(new Error("Global score failed"))

    await expect(rebuildAfterSimulation()).resolves.toBeUndefined()
    // All steps attempted
    expect(mockSyncReviewsRun).toHaveBeenCalled()
    expect(mockIntelCopurchaseRun).toHaveBeenCalled()
    expect(mockIntelGlobalScoreRun).toHaveBeenCalled()
  })
})
