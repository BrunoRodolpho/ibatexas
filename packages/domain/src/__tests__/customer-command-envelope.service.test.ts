// Smoke tests for the customer-service envelope-typed entry points
// added in W9 (audit-2026-05-23):
//
//   - `updatePreferencesFromEnvelope` — extended to forward favoriteCategories
//     from the pack-customer-onboarding payload (previously dropped).
//   - `submitReviewFromEnvelope` — new envelope wrapper routing through the
//     pack-orders policy (rating range + orderId presence).
//
// Mock-based; no DB or external services required. We only assert the
// kernel chokepoint contract — the EXECUTE branch reaches the underlying
// upserts with the expected payload, and the REFUSE branch short-circuits.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import { Channel } from "@ibatexas/types"

// ── Hoisted prisma mocks ────────────────────────────────────────────────────

const mockPrefsUpsert = vi.hoisted(() => vi.fn())
const mockReviewUpsert = vi.hoisted(() => vi.fn())
const mockReviewAggregate = vi.hoisted(() => vi.fn())

vi.mock("../client.js", () => ({
  prisma: {
    customerPreferences: { upsert: mockPrefsUpsert },
    review: {
      upsert: mockReviewUpsert,
      aggregate: mockReviewAggregate,
    },
  },
}))

// ── Import under test ──────────────────────────────────────────────────────

import { createCustomerService } from "../services/customer.service.js"
import type {
  CustomerOnboardingState,
  CustomerPreferencesUpdatePayload,
} from "@ibatexas/pack-customer-onboarding"
import type {
  OrderReviewSubmitPayload,
  OrderState,
} from "@ibatexas/pack-orders"

// ── Fixtures ───────────────────────────────────────────────────────────────

function preferencesEnvelope(payload: CustomerPreferencesUpdatePayload) {
  return buildEnvelope<"customer.preferences.update", CustomerPreferencesUpdatePayload>({
    kind: "customer.preferences.update",
    payload,
    nonce: "n-test",
    actor: { principal: "llm", sessionId: "s-1" },
    taint: "UNTRUSTED",
  })
}

function preferencesState(): CustomerOnboardingState {
  return {
    ctx: {
      actor: { principal: "user", id: "cus_01" },
      customerId: "cus_01",
      customerExists: true,
      isAuthenticated: true,
      otpFresh: false,
      hasParkedAnonymize: false,
      now: new Date("2026-05-22T12:00:00.000Z"),
    },
  }
}

function reviewEnvelope(payload: OrderReviewSubmitPayload) {
  return buildEnvelope<"order.review.submit", OrderReviewSubmitPayload>({
    kind: "order.review.submit",
    payload,
    nonce: "n-test",
    actor: { principal: "llm", sessionId: "s-1" },
    taint: "UNTRUSTED",
  })
}

function reviewState(overrides: Partial<OrderState["ctx"]> = {}): OrderState {
  return {
    ctx: {
      channel: "whatsapp",
      customerId: "cus_01",
      cartId: null,
      orderId: "order_01",
      ...overrides,
    },
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("updatePreferencesFromEnvelope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrefsUpsert.mockResolvedValue({})
  })

  it("EXECUTE: forwards favoriteCategories from the payload to Prisma upsert", async () => {
    // The service returns the AUTHORITATIVE stored row from the upsert (not
    // the coerced inputs) — mock what real Prisma resolves.
    mockPrefsUpsert.mockResolvedValue({
      customerId: "cus_01",
      allergenExclusions: ["lactose"],
      dietaryRestrictions: ["vegetariano"],
      favoriteCategories: ["churrasco", "grelhados"],
    })
    const svc = createCustomerService()
    const outcome = await svc.updatePreferencesFromEnvelope(
      preferencesEnvelope({
        allergenExclusions: ["lactose"],
        dietaryFlags: ["vegetariano"],
        favoriteCategories: ["churrasco", "grelhados"],
      }),
      preferencesState(),
      { customerId: "cus_01" },
    )

    expect(outcome.decision.kind).toBe("EXECUTE")
    expect(outcome.result).toEqual({
      allergenExclusions: ["lactose"],
      dietaryRestrictions: ["vegetariano"],
      favoriteCategories: ["churrasco", "grelhados"],
    })
    expect(mockPrefsUpsert).toHaveBeenCalledOnce()
    const call = mockPrefsUpsert.mock.calls[0][0]
    expect(call.create.favoriteCategories).toEqual(["churrasco", "grelhados"])
    expect(call.update.favoriteCategories).toEqual(["churrasco", "grelhados"])
  })

  it("EXECUTE: omits favoriteCategories from update clause when payload omits it", async () => {
    const svc = createCustomerService()
    await svc.updatePreferencesFromEnvelope(
      preferencesEnvelope({ allergenExclusions: ["lactose"] }),
      preferencesState(),
      { customerId: "cus_01" },
    )

    const call = mockPrefsUpsert.mock.calls[0][0]
    expect(call.update).not.toHaveProperty("favoriteCategories")
  })

  it("REFUSE: allergens not explicit (non-array) does NOT call Prisma", async () => {
    const svc = createCustomerService()
    const outcome = await svc.updatePreferencesFromEnvelope(
      preferencesEnvelope({
        // intentionally malformed; cast to bypass the pack-side typing
        allergenExclusions: "amendoim, lactose" as unknown as ReadonlyArray<string>,
      }),
      preferencesState(),
      { customerId: "cus_01" },
    )

    expect(outcome.decision.kind).toBe("REFUSE")
    if (outcome.decision.kind === "REFUSE") {
      expect(outcome.decision.refusal.code).toBe("customer.allergens.must_be_explicit")
    }
    expect(mockPrefsUpsert).not.toHaveBeenCalled()
  })
})

describe("submitReviewFromEnvelope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReviewUpsert.mockResolvedValue({})
    mockReviewAggregate.mockResolvedValue({
      _avg: { rating: 4.5 },
      _count: { rating: 10 },
    })
  })

  it("EXECUTE happy path: upserts review and returns aggregate stats", async () => {
    const svc = createCustomerService()
    const outcome = await svc.submitReviewFromEnvelope(
      reviewEnvelope({
        orderId: "order_01",
        productId: "prod_01",
        rating: 5,
        comment: "Excelente!",
      }),
      reviewState(),
      { customerId: "cus_01", channel: Channel.WhatsApp },
    )

    expect(outcome.decision.kind).toBe("EXECUTE")
    expect(outcome.result).toEqual({ avgRating: 4.5, reviewCount: 10 })
    expect(mockReviewUpsert).toHaveBeenCalledOnce()
    const upsertCall = mockReviewUpsert.mock.calls[0][0]
    expect(upsertCall.create.rating).toBe(5)
    expect(upsertCall.create.comment).toBe("Excelente!")
    expect(upsertCall.create.customerId).toBe("cus_01")
  })

  it("REFUSE: out-of-range rating short-circuits before Prisma", async () => {
    const svc = createCustomerService()
    const outcome = await svc.submitReviewFromEnvelope(
      reviewEnvelope({
        orderId: "order_01",
        productId: "prod_01",
        rating: 99 as unknown as number,
      }),
      reviewState(),
      { customerId: "cus_01", channel: Channel.WhatsApp },
    )

    expect(outcome.decision.kind).toBe("REFUSE")
    if (outcome.decision.kind === "REFUSE") {
      expect(outcome.decision.refusal.code).toBe("order.review.rating_invalid")
    }
    expect(mockReviewUpsert).not.toHaveBeenCalled()
  })

  it("REFUSE: missing orderId in state surfaces order.not_found", async () => {
    const svc = createCustomerService()
    const outcome = await svc.submitReviewFromEnvelope(
      reviewEnvelope({
        orderId: "order_01",
        productId: "prod_01",
        rating: 4,
      }),
      reviewState({ orderId: null }),
      { customerId: "cus_01", channel: Channel.WhatsApp },
    )

    expect(outcome.decision.kind).toBe("REFUSE")
    if (outcome.decision.kind === "REFUSE") {
      expect(outcome.decision.refusal.code).toBe("order.not_found")
    }
    expect(mockReviewUpsert).not.toHaveBeenCalled()
  })
})
