// Tests for submit_review tool
// Mock-based; no database, Typesense, or NATS required.
//
// ── Kernel routing (post-W9) ──────────────────────────────────────────────
//
// The tool now builds an `order.review.submit` IntentEnvelope and routes
// via `svc.submitReviewFromEnvelope`. The mock surfaces both EXECUTE and
// REFUSE paths so we can assert that:
//   - The envelope is built with the right kind / taint / actor
//   - State carries the orderId so the pack's requireOrderIdForMutation
//     guard reaches EXECUTE rather than REFUSEing on missing-order
//   - Typesense + NATS fire only on EXECUTE
//
// Scenarios:
// - Auth check: throws when no customerId
// - Rating validation at the wire schema (Zod): rejects < 1, > 5, non-integer
// - Happy path: envelope built, Typesense updated, NATS published
// - REFUSE outcome surfaces kernel refusal copy
// - Typesense failure is non-fatal
// - pt-BR messages in output

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Channel } from "@ibatexas/types"
import type { AgentContext } from "@ibatexas/types"
import {
  submitReview,
  submitReviewPreAdjudicated,
} from "../submit-review.js"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockSubmitReviewFromEnvelope = vi.hoisted(() => vi.fn())
const mockSubmitReviewSvc = vi.hoisted(() => vi.fn())
const mockTypesenseUpdate = vi.hoisted(() => vi.fn())
const mockGetTypesenseClient = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    submitReviewFromEnvelope: mockSubmitReviewFromEnvelope,
    submitReview: mockSubmitReviewSvc,
  }),
}))

vi.mock("../../typesense/client.js", () => ({
  getTypesenseClient: mockGetTypesenseClient,
  COLLECTION: "products",
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

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

function execOutcome(result: { avgRating: number; reviewCount: number }) {
  return {
    decision: { kind: "EXECUTE" as const },
    result,
  }
}

// -- Tests ────────────────────────────────────────────────────────────────────

describe("submitReview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTypesenseClient.mockReturnValue({
      collections: () => ({
        documents: (_id: string) => ({
          update: mockTypesenseUpdate,
        }),
      }),
    })
    mockTypesenseUpdate.mockResolvedValue({})
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockSubmitReviewFromEnvelope.mockResolvedValue(
      execOutcome({ avgRating: 4.5, reviewCount: 10 }),
    )
  })

  // ── Auth ────────────────────────────────────────────────────────────────

  it("throws when customerId is missing", async () => {
    await expect(submitReview(VALID_INPUT, CTX_GUEST as AgentContext)).rejects.toThrow(
      "Autenticação necessária",
    )
    expect(mockSubmitReviewFromEnvelope).not.toHaveBeenCalled()
  })

  // ── Wire-schema rating validation (Zod, pre-envelope) ──────────────────

  it("rejects rating below 1 at the wire schema", async () => {
    await expect(
      submitReview({ ...VALID_INPUT, rating: 0 }, CTX_AUTH),
    ).rejects.toThrow()
    expect(mockSubmitReviewFromEnvelope).not.toHaveBeenCalled()
  })

  it("rejects rating above 5 at the wire schema", async () => {
    await expect(
      submitReview({ ...VALID_INPUT, rating: 6 }, CTX_AUTH),
    ).rejects.toThrow()
    expect(mockSubmitReviewFromEnvelope).not.toHaveBeenCalled()
  })

  it("rejects non-integer rating at the wire schema", async () => {
    await expect(
      submitReview({ ...VALID_INPUT, rating: 3.5 }, CTX_AUTH),
    ).rejects.toThrow()
    expect(mockSubmitReviewFromEnvelope).not.toHaveBeenCalled()
  })

  // ── Envelope construction ─────────────────────────────────────────────

  it("builds an order.review.submit envelope with UNTRUSTED taint + llm principal", async () => {
    await submitReview(VALID_INPUT, CTX_AUTH)

    expect(mockSubmitReviewFromEnvelope).toHaveBeenCalledOnce()
    const [envelope, state, extras] = mockSubmitReviewFromEnvelope.mock.calls[0]
    expect(envelope.kind).toBe("order.review.submit")
    expect(envelope.taint).toBe("UNTRUSTED")
    expect(envelope.actor.principal).toBe("llm")
    expect(envelope.actor.sessionId).toBe("customer:cus_01")
    expect(envelope.payload.orderId).toBe("order_01")
    expect(envelope.payload.productId).toBe("prod_01")
    expect(envelope.payload.rating).toBe(5)
    expect(envelope.payload.comment).toBe("Excelente!")
    expect(state.ctx.customerId).toBe("cus_01")
    expect(state.ctx.orderId).toBe("order_01")
    expect(state.ctx.channel).toBe("whatsapp")
    expect(extras).toEqual({ customerId: "cus_01", channel: Channel.WhatsApp })
  })

  it("omits comment from payload when not provided", async () => {
    await submitReview(
      { productId: "prod_01", orderId: "order_01", rating: 4 },
      CTX_AUTH,
    )

    const [envelope] = mockSubmitReviewFromEnvelope.mock.calls[0]
    expect(envelope.payload).not.toHaveProperty("comment")
  })

  // ── Cache + NATS fire on EXECUTE ──────────────────────────────────────

  it("updates Typesense with new rating and reviewCount on EXECUTE", async () => {
    await submitReview(VALID_INPUT, CTX_AUTH)

    expect(mockTypesenseUpdate).toHaveBeenCalledWith({
      rating: 4.5,
      reviewCount: 10,
    })
  })

  it("publishes NATS event with correct payload on EXECUTE", async () => {
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

  // ── REFUSE propagates ────────────────────────────────────────────────

  it("surfaces the kernel refusal copy and skips side effects on REFUSE", async () => {
    mockSubmitReviewFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE" as const,
        refusal: {
          category: "BUSINESS_RULE",
          code: "order.review.rating_invalid",
          userFacing: "A nota da avaliação precisa ser um número inteiro de 1 a 5 estrelas.",
        },
      },
    })

    await expect(submitReview(VALID_INPUT, CTX_AUTH)).rejects.toThrow(
      "A nota da avaliação precisa ser um número inteiro de 1 a 5 estrelas.",
    )

    expect(mockTypesenseUpdate).not.toHaveBeenCalled()
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
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
    mockSubmitReviewFromEnvelope.mockResolvedValue(
      execOutcome({ avgRating: 5, reviewCount: 1 }),
    )

    await submitReview(VALID_INPUT, CTX_AUTH)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "review.submitted",
      expect.objectContaining({
        newAvgRating: 5,
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

  // ── Web channel projection ────────────────────────────────────────────

  it("maps Channel.Web to web in the state projection", async () => {
    await submitReview(VALID_INPUT, {
      customerId: "cus_01",
      channel: Channel.Web,
      sessionId: "sess_01",
      userType: "customer",
    } as AgentContext)

    const [, state] = mockSubmitReviewFromEnvelope.mock.calls[0]
    expect(state.ctx.channel).toBe("web")
  })
})

// BKL-243 — the conductor-dispatch entry point. `order.review.submit` is in
// AUTORESOLVE_CONFIRM_KINDS, so the live shape is a park-then-confirm turn whose
// resume leg dispatches this handler on a kernel EXECUTE the Conductor already
// audited and ledger-claimed. Re-minting an envelope here adjudicated the same
// intent a second time, and that second run was AUDIT-BLIND
// (`createCustomerService()` takes no auditSink), so an inner REFUSE would have
// silently contradicted the audited EXECUTE. Same class and same fix shape as
// BKL-232 (`reservation.modify`, PR #386).
describe("submitReviewPreAdjudicated (BKL-243)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTypesenseClient.mockReturnValue({
      collections: () => ({
        documents: (_id: string) => ({
          update: mockTypesenseUpdate,
        }),
      }),
    })
    mockTypesenseUpdate.mockResolvedValue({})
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockSubmitReviewSvc.mockResolvedValue({ avgRating: 4.5, reviewCount: 10 })
  })

  it("writes via the bare service method and NEVER re-adjudicates", async () => {
    const result = await submitReviewPreAdjudicated(VALID_INPUT, CTX_AUTH)

    // No second envelope, no second kernel run, no audit-blind inner decision.
    expect(mockSubmitReviewFromEnvelope).not.toHaveBeenCalled()
    // The write still runs exactly once, with the customerId + channel from the
    // verified ctx (never from the model payload).
    expect(mockSubmitReviewSvc).toHaveBeenCalledExactlyOnceWith({
      customerId: "cus_01",
      productId: "prod_01",
      orderId: "order_01",
      rating: 5,
      comment: "Excelente!",
      channel: Channel.WhatsApp,
    })
    // Same success shape + side effects as the self-adjudicating entry point.
    expect(result.success).toBe(true)
    expect(result.message).toContain("Avaliação enviada!")
    expect(mockTypesenseUpdate).toHaveBeenCalledWith({ rating: 4.5, reviewCount: 10 })
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "review.submitted",
      expect.objectContaining({ eventType: "review.submitted" }),
    )
  })

  it("still runs the auth check before any write", async () => {
    await expect(
      submitReviewPreAdjudicated(VALID_INPUT, CTX_GUEST as AgentContext),
    ).rejects.toThrow("Autenticação necessária")

    expect(mockSubmitReviewSvc).not.toHaveBeenCalled()
    expect(mockSubmitReviewFromEnvelope).not.toHaveBeenCalled()
  })

  it("still rejects an out-of-range rating at the wire schema, before any write", async () => {
    await expect(
      submitReviewPreAdjudicated({ ...VALID_INPUT, rating: 0 }, CTX_AUTH),
    ).rejects.toThrow()

    expect(mockSubmitReviewSvc).not.toHaveBeenCalled()
  })

  it("omits comment from the write when the caller does not provide one", async () => {
    const { comment: _comment, ...noComment } = VALID_INPUT
    await submitReviewPreAdjudicated(noComment, CTX_AUTH)

    const [payload] = mockSubmitReviewSvc.mock.calls[0]
    expect(payload).not.toHaveProperty("comment")
  })
})
