// Tests for amend_order — change_payment action
// Mock-based; no network or DB required.
//
// Scenarios:
// - PIX → cash: transitions switching_method → canceled, creates cash_pending Payment, publishes events
// - PIX → card: creates new Stripe PI, creates payment_pending Payment
// - Already paid (terminal status) → returns "Pagamento já finalizado" error
// - Same method → returns "Já está usando este método" error
// - No active payment → falls back to legacy path (cancel Medusa metadata PI)
//
// ── W3 P0-3 (audit remediation) ────────────────────────────────────────
//
// All payment mutations now route through `*FromEnvelope`. The legacy
// `transitionStatus` / `create` bare-arg methods MUST NOT be called by
// this tool. Tests assert envelope-typed mocks were used.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { amendOrder } from "../amend-order.js"
import { makeCtx, orderResponse } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn())
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockGetById = vi.hoisted(() => vi.fn())
const mockTransitionStatus = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn())
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn())
const mockGetOrder = vi.hoisted(() => vi.fn())
const mockCancelStalePaymentIntent = vi.hoisted(() => vi.fn())
const mockStripePaymentIntentsCreate = vi.hoisted(() => vi.fn())
const mockGetStripe = vi.hoisted(() => vi.fn())
const mockWithLock = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}))

// W3 P0-3: medusaAdjudicated wraps all admin POSTs from this tool.
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
    transitionStatus: mockTransitionStatus,
    create: mockCreate,
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
    createFromEnvelope: mockCreateFromEnvelope,
  })),
}))

vi.mock("../_stripe-helpers.js", () => ({
  cancelStalePaymentIntent: mockCancelStalePaymentIntent,
  getStripe: mockGetStripe,
}))

vi.mock("../../redis/distributed-lock.js", () => ({
  withLock: mockWithLock,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = {
  orderId: "order_01",
  action: "change_payment" as const,
  paymentMethod: "cash" as const,
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

function makeCreatedPayment(overrides?: Record<string, unknown>) {
  return {
    id: "pay_02",
    orderId: "order_01",
    method: "cash",
    status: "cash_pending",
    amountInCentavos: 26700,
    version: 1,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("amendOrder — change_payment", () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: order is pending and owned by cust_01
    mockGetOrder.mockResolvedValue({
      order: {
        id: "order_01",
        status: "pending",
        customer_id: "cust_01",
        items: [],
        total: 26700,
        metadata: { stripePaymentIntentId: "pi_test_pix_01" },
      },
      ownershipValid: true,
    })

    // Default: medusaAdmin returns a minimal order response
    mockMedusaAdmin.mockResolvedValue(orderResponse())

    // Default: withLock calls the callback directly
    mockWithLock.mockImplementation(
      async (_key: string, fn: () => Promise<unknown>) => fn(),
    )

    // Default: Stripe stub
    mockGetStripe.mockReturnValue({
      paymentIntents: {
        create: mockStripePaymentIntentsCreate,
      },
    })

    mockCancelStalePaymentIntent.mockResolvedValue(undefined)
    mockTransitionStatus.mockResolvedValue(undefined)
    mockPublishNatsEvent.mockResolvedValue(undefined)

    // W3 P0-3: envelope-typed paths now own the writes. Default to
    // EXECUTE for happy-path tests; individual tests override.
    mockTransitionStatusFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, previousStatus: "awaiting_payment", newStatus: "canceled" },
    })
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "pay_02", version: 1 },
    })
    mockMedusaAdjudicated.mockResolvedValue({ order_edit: { id: "edit_01" } })
  })

  describe("happy path: PIX → cash", () => {
    beforeEach(() => {
      const activePayment = makeActivePayment()
      mockGetActiveByOrderId.mockResolvedValue(activePayment)
      mockGetById.mockResolvedValue({ ...activePayment, version: 2 })
      mockCreateFromEnvelope.mockResolvedValue({
        decision: { kind: "EXECUTE", basis: [] },
        result: makeCreatedPayment(),
      })
    })

    it("transitions active payment to switching_method then canceled via *FromEnvelope (W3 P0-3)", async () => {
      await amendOrder(INPUT, CTX)

      // W3 P0-3: envelope-typed path is the only one called.
      expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledTimes(2)
      const firstEnv = mockTransitionStatusFromEnvelope.mock.calls[0][0]
      expect(firstEnv.kind).toBe("payment.status.transition")
      expect(firstEnv.payload).toMatchObject({
        paymentId: "pay_01",
        newStatus: "switching_method",
        actor: "customer",
        actorId: "cust_01",
        reason: "switch_to_cash",
        expectedVersion: 1,
      })
      const secondEnv = mockTransitionStatusFromEnvelope.mock.calls[1][0]
      expect(secondEnv.kind).toBe("payment.status.transition")
      expect(secondEnv.payload).toMatchObject({
        paymentId: "pay_01",
        newStatus: "canceled",
        actor: "customer",
        actorId: "cust_01",
        reason: "method_switch_completed",
      })

      // Legacy bare-arg path MUST NOT have been called.
      expect(mockTransitionStatus).not.toHaveBeenCalled()
    })

    it("cancels old Stripe PI when switching away from pix", async () => {
      await amendOrder(INPUT, CTX)

      expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith("pi_test_pix_01")
    })

    it("creates new cash_pending Payment row via createFromEnvelope (W3 P0-3)", async () => {
      await amendOrder(INPUT, CTX)

      expect(mockCreateFromEnvelope).toHaveBeenCalledTimes(1)
      const env = mockCreateFromEnvelope.mock.calls[0][0]
      expect(env.kind).toBe("payment.create")
      expect(env.taint).toBe("SYSTEM")
      expect(env.payload).toMatchObject({
        orderId: "order_01",
        method: "cash",
        amountInCentavos: 26700,
      })
      // Legacy bare-arg path MUST NOT have been called.
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it("does not create a Stripe PI for cash method", async () => {
      await amendOrder(INPUT, CTX)

      expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled()
    })

    it("publishes payment.method_changed event", async () => {
      await amendOrder(INPUT, CTX)

      expect(mockPublishNatsEvent).toHaveBeenCalledWith(
        "payment.method_changed",
        expect.objectContaining({
          orderId: "order_01",
          previousMethod: "pix",
          newMethod: "cash",
        }),
      )
    })

    it("publishes payment.status_changed event with cash_pending", async () => {
      await amendOrder(INPUT, CTX)

      expect(mockPublishNatsEvent).toHaveBeenCalledWith(
        "payment.status_changed",
        expect.objectContaining({
          orderId: "order_01",
          newStatus: "cash_pending",
          method: "cash",
        }),
      )
    })

    it("returns success:true with pt-BR cash message", async () => {
      const result = await amendOrder(INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.message).toContain("dinheiro")
    })
  })

  describe("happy path: PIX → card", () => {
    const CARD_INPUT = { ...INPUT, paymentMethod: "card" as const }

    beforeEach(() => {
      const activePayment = makeActivePayment()
      mockGetActiveByOrderId.mockResolvedValue(activePayment)
      mockGetById.mockResolvedValue({ ...activePayment, version: 2 })
      mockStripePaymentIntentsCreate.mockResolvedValue({
        id: "pi_card_01",
        client_secret: "pi_card_01_secret",
        payment_method_types: ["card"],
      })
      mockCreateFromEnvelope.mockResolvedValue({
        decision: { kind: "EXECUTE", basis: [] },
        result: makeCreatedPayment({ id: "pay_03", method: "card" }),
      })
    })

    it("creates a Stripe PaymentIntent with card payment method", async () => {
      await amendOrder(CARD_INPUT, CTX)

      expect(mockStripePaymentIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 26700,
          currency: "brl",
          payment_method_types: ["card"],
          metadata: { orderId: "order_01" },
        }),
      )
    })

    it("creates new Payment row with the Stripe PI id via createFromEnvelope (W3 P0-3)", async () => {
      await amendOrder(CARD_INPUT, CTX)

      expect(mockCreateFromEnvelope).toHaveBeenCalledTimes(1)
      const env = mockCreateFromEnvelope.mock.calls[0][0]
      expect(env.kind).toBe("payment.create")
      expect(env.payload).toMatchObject({
        orderId: "order_01",
        method: "card",
        amountInCentavos: 26700,
        stripePaymentIntentId: "pi_card_01",
      })
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it("returns success:true with stripeClientSecret", async () => {
      const result = await amendOrder(CARD_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.message).toContain("cartão")
      expect((result as { stripeClientSecret?: string }).stripeClientSecret).toBe("pi_card_01_secret")
    })

    it("publishes payment.status_changed with payment_pending for card", async () => {
      await amendOrder(CARD_INPUT, CTX)

      expect(mockPublishNatsEvent).toHaveBeenCalledWith(
        "payment.status_changed",
        expect.objectContaining({
          newStatus: "payment_pending",
          method: "card",
        }),
      )
    })
  })

  describe("already paid (terminal status)", () => {
    it.each(["paid", "refunded", "canceled", "waived"])(
      "returns success:false for status '%s'",
      async (status) => {
        mockGetActiveByOrderId.mockResolvedValue(makeActivePayment({ status }))

        const result = await amendOrder(INPUT, CTX)

        expect(result.success).toBe(false)
        expect(result.message).toBe("Pagamento já finalizado — não pode trocar.")
      },
    )
  })

  describe("same method — no-op", () => {
    it("returns success:false when switching to the same method already in use", async () => {
      const PIX_INPUT = { ...INPUT, paymentMethod: "pix" as const }
      mockGetActiveByOrderId.mockResolvedValue(makeActivePayment({ method: "pix" }))

      const result = await amendOrder(PIX_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.message).toBe("Já está usando este método de pagamento.")
    })

    it("does not call any payment mutation when method is unchanged", async () => {
      const PIX_INPUT = { ...INPUT, paymentMethod: "pix" as const }
      mockGetActiveByOrderId.mockResolvedValue(makeActivePayment({ method: "pix" }))

      await amendOrder(PIX_INPUT, CTX)

      expect(mockTransitionStatus).not.toHaveBeenCalled()
      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled()
      expect(mockCreate).not.toHaveBeenCalled()
      expect(mockCreateFromEnvelope).not.toHaveBeenCalled()
    })
  })

  describe("no active payment — legacy fallback", () => {
    beforeEach(() => {
      mockGetActiveByOrderId.mockResolvedValue(null)
    })

    it("cancels the Medusa metadata PI when present", async () => {
      await amendOrder(INPUT, CTX)

      expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith("pi_test_pix_01")
    })

    it("returns success:true with pt-BR message", async () => {
      const result = await amendOrder(INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.message).toContain("dinheiro")
    })

    it("does not call any payment-mutation path when no active payment exists", async () => {
      await amendOrder(INPUT, CTX)

      expect(mockTransitionStatus).not.toHaveBeenCalled()
      expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled()
      expect(mockCreate).not.toHaveBeenCalled()
      expect(mockCreateFromEnvelope).not.toHaveBeenCalled()
    })

    it("does not attempt to cancel PI when order metadata has none", async () => {
      mockGetOrder.mockResolvedValue({
        order: {
          id: "order_01",
          status: "pending",
          customer_id: "cust_01",
          items: [],
          total: 26700,
          metadata: {},
        },
        ownershipValid: true,
      })

      await amendOrder(INPUT, CTX)

      expect(mockCancelStalePaymentIntent).not.toHaveBeenCalled()
    })
  })
})
