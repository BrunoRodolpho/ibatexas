// Tests for submit_review tool
// Mock-based; no database, Typesense, or NATS required.
//
// Scenarios:
// - Auth check: throws when no customerId
// - Rating validation: rejects < 1, > 5, and non-integer
// - Happy path: upserts review, aggregates stats, updates Typesense, publishes NATS
// - Typesense update failure is non-fatal
// - Optional comment handling
// - pt-BR messages in output

import { describe, it, expect, beforeEach, vi } from "vitest"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockReviewUpsert = vi.hoisted(() => vi.fn())
const mockReviewAggregate = vi.hoisted(() => vi.fn())
const mockTypesenseUpdate = vi.hoisted(() => vi.fn())
const mockGetTypesenseClient = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    review: {
      upsert: mockReviewUpsert,
      aggregate: mockReviewAggregate,
    },
  },
  createCustomerService: () => ({
    submitReview: async (input: {
      customerId: string; productId: string; orderId: string;
      rating: number; comment?: string; channel: string;
    }) => {
      const { customerId, productId, orderId, rating, comment, channel } = input
      await mockReviewUpsert({
        where: { orderId_customerId: { orderId, customerId } },
        create: { orderId, productId, productIds: [productId], customerId, rating, comment: comment ?? null, channel },
        update: { rating, comment: comment ?? null },
      })
      const stats = await mockReviewAggregate({
        where: { productId },
        _avg: { rating: true },
        _count: { rating: true },
      })
      return {
        avgRating: stats._avg.rating ?? rating,
        reviewCount: stats._count.rating,
      }
    },
  }),
}))

vi.mock("../../typesense/client.js", () => ({
  getTypesenseClient: mockGetTypesenseClient,
  COLLECTION: "products",
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// -- Imports ──────────────────────────────────────────────────────────────────

import { Channel } from "@ibatexas/types"
import { submitReview } from "../submit-review.js"

// -- Fixtures ─────────────────────────────────────────────────────────────────

const CTX_AUTH = {
  customerId: "cus_01",
  channel: Channel.WhatsApp,
  sessionId: "sess_01",
  userType: "customer" as const,
}

const CTX_GUEST = {
  channel: Channel.Web,
  sessionId: "sess_02",
  userType: "guest" as const,
}

const VALID_INPUT = {
  productId: "prod_01",
  orderId: "order_01",
  rating: 5,
  comment: "Excelente!",
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("submitReview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReviewUpsert.mockResolvedValue({})
    mockReviewAggregate.mockResolvedValue({
      _avg: { rating: 4.5 },
      _count: { rating: 10 },
    })
    mockGetTypesenseClient.mockReturnValue({
      collections: () => ({
        documents: (id: string) => ({
          update: mockTypesenseUpdate,
        }),
      }),
    })
    mockTypesenseUpdate.mockResolvedValue({})
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  // ── Auth ────────────────────────────────────────────────────────────────

  it("throws when customerId is missing", async () => {
    await expect(submitReview(VALID_INPUT, CTX_GUEST as any)).rejects.toThrow(
      "Autenticação necessária",
    )
  })

  // ── Rating validation ──────────────────────────────────────────────────

  it("rejects rating below 1", async () => {
    await expect(
      submitReview({ ...VALID_INPUT, rating: 0 }, CTX_AUTH),
    ).rejects.toThrow()
    expect(mockReviewUpsert).not.toHaveBeenCalled()
  })

  it("rejects rating above 5", async () => {
    await expect(
      submitReview({ ...VALID_INPUT, rating: 6 }, CTX_AUTH),
    ).rejects.toThrow()
    expect(mockReviewUpsert).not.toHaveBeenCalled()
  })

  it("rejects non-integer rating", async () => {
    await expect(
      submitReview({ ...VALID_INPUT, rating: 3.5 }, CTX_AUTH),
    ).rejects.toThrow()
    expect(mockReviewUpsert).not.toHaveBeenCalled()
  })

  // ── Happy path ─────────────────────────────────────────────────────────

  it("upserts review in Prisma on happy path", async () => {
    await submitReview(VALID_INPUT, CTX_AUTH)

    expect(mockReviewUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderId_customerId: {
            orderId: "order_01",
            customerId: "cus_01",
          },
        },
        create: expect.objectContaining({
          orderId: "order_01",
          productId: "prod_01",
          productIds: ["prod_01"],
          customerId: "cus_01",
          rating: 5,
          comment: "Excelente!",
          channel: "whatsapp",
        }),
        update: expect.objectContaining({
          rating: 5,
          comment: "Excelente!",
        }),
      }),
    )
  })

  it("aggregates review stats for the product", async () => {
    await submitReview(VALID_INPUT, CTX_AUTH)

    expect(mockReviewAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId: "prod_01" },
        _avg: { rating: true },
        _count: { rating: true },
      }),
    )
  })

  it("updates Typesense with new rating and reviewCount", async () => {
    await submitReview(VALID_INPUT, CTX_AUTH)

    expect(mockTypesenseUpdate).toHaveBeenCalledWith({
      rating: 4.5,
      reviewCount: 10,
    })
  })

  it("publishes NATS event with correct payload", async () => {
    await submitReview(VALID_INPUT, CTX_AUTH)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "review.submitted",
      expect.objectContaining({
        eventType: "review.submitted",
        productId: "prod_01",
        orderId: "order_01",
        customerId: "cus_01",
        rating: 5,
        reviewCount: 10,
        newAvgRating: 4.5,
      }),
    )
  })

  it("returns success with pt-BR message including stars", async () => {
    const result = await submitReview(VALID_INPUT, CTX_AUTH)

    expect(result.success).toBe(true)
    expect(result.message).toContain("Avaliação enviada!")
    expect(result.message).toContain("Obrigado")
  })

  // ── Optional comment ───────────────────────────────────────────────────

  it("sets comment to null when not provided", async () => {
    await submitReview(
      { productId: "prod_01", orderId: "order_01", rating: 4 },
      CTX_AUTH,
    )

    expect(mockReviewUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ comment: null }),
        update: expect.objectContaining({ comment: null }),
      }),
    )
  })

  // ── Typesense failure is non-fatal ─────────────────────────────────────

  it("succeeds even when Typesense update fails", async () => {
    mockTypesenseUpdate.mockRejectedValue(new Error("Typesense down"))

    const result = await submitReview(VALID_INPUT, CTX_AUTH)

    expect(result.success).toBe(true)
    expect(mockPublishNatsEvent).toHaveBeenCalled()
  })

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("uses current rating as fallback when aggregate _avg is null", async () => {
    mockReviewAggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { rating: 1 },
    })

    await submitReview(VALID_INPUT, CTX_AUTH)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "review.submitted",
      expect.objectContaining({
        newAvgRating: 5, // falls back to the input rating
      }),
    )
  })

  it("handles rating of exactly 1", async () => {
    const result = await submitReview(
      { ...VALID_INPUT, rating: 1 },
      CTX_AUTH,
    )

    expect(result.success).toBe(true)
  })

  it("handles rating of exactly 5", async () => {
    const result = await submitReview(
      { ...VALID_INPUT, rating: 5 },
      CTX_AUTH,
    )

    expect(result.success).toBe(true)
  })
})
