// Tests for amend_order — post-amendment payment sync (P1-CONC-AMEND).
// Mock-based; no network or DB required.
//
// Exercises `syncPaymentAndPixAfterAmendment` via the `add` action:
// - Happy path: the PI regeneration + Payment-row swap run INSIDE a
//   `withLock('payment:<id>')` critical section, with a re-read of the payment
//   state before mutating. Cancel + create both route through `*FromEnvelope`.
// - Concurrent amendment: the re-read inside the lock observes a terminal
//   payment (another amendment already swapped) and SKIPS — no Stripe PI
//   regeneration, no cancel/create, so it never orphans the other amendment's
//   fresh active payment.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { amendOrder } from "../amend-order.js"
import { makeCtx, orderResponse } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn())
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockGetById = vi.hoisted(() => vi.fn())
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn())
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn())
const mockGetOrder = vi.hoisted(() => vi.fn())
const mockCancelStalePaymentIntent = vi.hoisted(() => vi.fn())
const mockStripePaymentIntentsCreate = vi.hoisted(() => vi.fn())
const mockWithLock = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}))

vi.mock("../../medusa/adjudicated.js", () => ({
  medusaAdjudicated: mockMedusaAdjudicated,
}))

vi.mock("@ibatexas/domain", () => ({
  createOrderService: vi.fn(() => ({
    getOrder: mockGetOrder,
    cancelItem: vi.fn(),
  })),
  createOrderQueryService: vi.fn(() => ({
    getById: vi.fn().mockResolvedValue({ fulfillmentStatus: "pending" }),
  })),
  createPaymentQueryService: vi.fn(() => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    getById: mockGetById,
  })),
  createPaymentCommandService: vi.fn(() => ({
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
    createFromEnvelope: mockCreateFromEnvelope,
  })),
}))

vi.mock("../_stripe-helpers.js", () => ({
  cancelStalePaymentIntent: mockCancelStalePaymentIntent,
  getStripe: vi.fn(),
}))

vi.mock("../../stripe/adjudicated.js", () => ({
  stripeAdjudicated: {
    paymentIntents: { create: mockStripePaymentIntentsCreate },
  },
}))

vi.mock("../../redis/distributed-lock.js", () => ({
  withLock: mockWithLock,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ADD_INPUT = {
  orderId: "order_01",
  action: "add" as const,
  variantId: "variant_01",
  quantity: 1,
}

const CTX = makeCtx({ customerId: "cust_01" })

function makeActivePayment(overrides?: Record<string, unknown>) {
  return {
    id: "pay_01",
    orderId: "order_01",
    method: "pix",
    status: "awaiting_payment",
    amountInCentavos: 26700,
    stripePaymentIntentId: "pi_test_pix_01",
    version: 1,
    ...overrides,
  }
}

function makeRegeneratedPi() {
  return {
    id: "pi_new_02",
    next_action: {
      pix_display_qr_code: {
        data: "000201-pix-copia-e-cola",
        image_url_svg: "https://stripe.test/qr.svg",
      },
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("amendOrder — post-amendment payment sync (P1-CONC-AMEND)", () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockGetOrder.mockResolvedValue({
      order: {
        id: "order_01",
        status: "pending",
        customer_id: "cust_01",
        items: [],
        total: 30000, // amended total (was 26700)
        metadata: { stripePaymentIntentId: "pi_test_pix_01" },
      },
      ownershipValid: true,
    })

    mockMedusaAdmin.mockResolvedValue(orderResponse())
    // order-edit create + add-item + confirm + metadata-update all resolve.
    mockMedusaAdjudicated.mockResolvedValue({ order_edit: { id: "edit_01" } })

    // withLock invokes the callback so we can assert the inside-lock behavior.
    mockWithLock.mockImplementation(
      async (_key: string, fn: () => Promise<unknown>) => fn(),
    )

    mockCancelStalePaymentIntent.mockResolvedValue(undefined)
    mockStripePaymentIntentsCreate.mockResolvedValue(makeRegeneratedPi())
    mockPublishNatsEvent.mockResolvedValue(undefined)

    mockTransitionStatusFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, previousStatus: "awaiting_payment", newStatus: "canceled" },
    })
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "pay_02", version: 1 },
    })
  })

  it("runs the PI regen + Payment-row swap INSIDE withLock('payment:<id>') with a re-read", async () => {
    const active = makeActivePayment()
    mockGetActiveByOrderId.mockResolvedValue(active)
    mockGetById.mockResolvedValue({ ...active, version: 1 }) // re-read: still active

    // `amendOrder` spreads the PIX result onto its return value at runtime; the
    // declared AmendOrderResult type doesn't surface the extra fields, so widen.
    const res = (await amendOrder(ADD_INPUT, CTX)) as {
      success: boolean
      newStripePaymentIntentId?: string
      newPixQrCodeText?: string
    }

    // Lock keyed on the active payment id.
    expect(mockWithLock).toHaveBeenCalledTimes(1)
    expect(mockWithLock.mock.calls[0][0]).toBe("payment:pay_01")
    // Re-read inside the lock before mutating.
    expect(mockGetById).toHaveBeenCalledWith("pay_01")
    // PI regenerated with the AMENDED total (integer centavos, Hard Rule #2).
    expect(mockStripePaymentIntentsCreate).toHaveBeenCalledTimes(1)
    expect(mockStripePaymentIntentsCreate.mock.calls[0][0]).toMatchObject({ amount: 30000, currency: "brl" })
    // Old payment canceled + new payment created — both kernel-adjudicated.
    expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledTimes(1)
    expect(mockTransitionStatusFromEnvelope.mock.calls[0][0].payload).toMatchObject({
      paymentId: "pay_01",
      newStatus: "canceled",
      expectedVersion: 1,
    })
    expect(mockCreateFromEnvelope).toHaveBeenCalledTimes(1)
    expect(mockCreateFromEnvelope.mock.calls[0][0].payload).toMatchObject({
      orderId: "order_01",
      method: "pix",
      amountInCentavos: 30000,
      stripePaymentIntentId: "pi_new_02",
    })
    // Customer gets the new PIX code back.
    expect(res.success).toBe(true)
    expect(res.newStripePaymentIntentId).toBe("pi_new_02")
    expect(res.newPixQrCodeText).toBe("000201-pix-copia-e-cola")
  })

  it("SKIPS the swap when the re-read finds a concurrently-canceled payment (no orphaning)", async () => {
    const active = makeActivePayment()
    mockGetActiveByOrderId.mockResolvedValue(active)
    // A concurrent amendment already swapped this payment → now terminal.
    mockGetById.mockResolvedValue({ ...active, status: "canceled" })

    const res = (await amendOrder(ADD_INPUT, CTX)) as {
      success: boolean
      newStripePaymentIntentId?: string
    }

    // Lock acquired + re-read done, but NOTHING mutated: no PI regen, no
    // cancel/create — we must not cancel the other amendment's fresh payment.
    expect(mockWithLock).toHaveBeenCalledTimes(1)
    expect(mockGetById).toHaveBeenCalledWith("pay_01")
    expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled()
    expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled()
    expect(mockCreateFromEnvelope).not.toHaveBeenCalled()
    // The add itself still succeeded; just no new PIX payload.
    expect(res.success).toBe(true)
    expect(res.newStripePaymentIntentId).toBeUndefined()
  })

  it("skips the lock entirely for legacy orders with no active Payment row", async () => {
    mockGetActiveByOrderId.mockResolvedValue(null)

    await amendOrder(ADD_INPUT, CTX)

    // No Payment-row invariant at stake → regenerate without a lock.
    expect(mockWithLock).not.toHaveBeenCalled()
    expect(mockGetById).not.toHaveBeenCalled()
    // Stripe PI still regenerated from Medusa metadata (legacy fallback).
    expect(mockStripePaymentIntentsCreate).toHaveBeenCalledTimes(1)
    // No Payment-row mutations (there is no row to swap).
    expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled()
    expect(mockCreateFromEnvelope).not.toHaveBeenCalled()
  })
})
