// Tests for cancel_order tool — Payment cancellation path
// Mock-based; no DB or network required.
//
// Scenarios:
// - Successful cancel → cancels order via Medusa + cancels active Payment
//   (transitions to canceled) + cancels Stripe PI + publishes payment.status_changed
// - Cancel when payment already in terminal status ("canceled") → skips payment
//   cancellation, order still cancels
// - Cancel when no active payment exists → order still cancels fine, no payment errors
// - Cancel when not authenticated → throws NonRetryableError
// - Cancel when order not found / ownership invalid → returns not found

import { describe, it, expect, beforeEach, vi } from "vitest"
import { cancelOrder } from "../cancel-order.js"
import { makeCtx, makeGuestCtx, orderResponse } from "./fixtures/medusa.js"
import { NonRetryableError } from "@ibatexas/types"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockCancelOrder = vi.hoisted(() => vi.fn())
const mockGetOrder = vi.hoisted(() => vi.fn())
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockTransitionStatus = vi.hoisted(() => vi.fn())
const mockCancelStalePaymentIntent = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: vi.fn(),
}))

vi.mock("@ibatexas/domain", () => ({
  createOrderService: vi.fn(() => ({
    cancelOrder: mockCancelOrder,
    getOrder: mockGetOrder,
  })),
  createPaymentQueryService: vi.fn(() => ({
    getActiveByOrderId: mockGetActiveByOrderId,
  })),
  createPaymentCommandService: vi.fn(() => ({
    transitionStatus: mockTransitionStatus,
  })),
}))

vi.mock("../_stripe-helpers.js", () => ({
  cancelStalePaymentIntent: mockCancelStalePaymentIntent,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = { orderId: "order_01" }
const CTX = makeCtx({ customerId: "cust_01" })

function makePayment(overrides?: Record<string, unknown>) {
  return {
    id: "pay_01",
    orderId: "order_01",
    status: "awaiting_payment",
    method: "pix",
    stripePaymentIntentId: "pi_test123",
    version: 3,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cancelOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockCancelStalePaymentIntent.mockResolvedValue(undefined)
    mockTransitionStatus.mockResolvedValue(undefined)
    // Default: order has no Stripe PI in metadata (avoids legacy path interference)
    mockGetOrder.mockResolvedValue(orderResponse({ metadata: {} }))
  })

  describe("successful cancellation with active payment", () => {
    beforeEach(() => {
      mockCancelOrder.mockResolvedValue({ success: true, message: "Pedido cancelado com sucesso." })
      mockGetActiveByOrderId.mockResolvedValue(makePayment())
    })

    it("cancels order via the order service", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockCancelOrder).toHaveBeenCalledWith(INPUT.orderId, CTX.customerId)
    })

    it("cancels Stripe PI for the active payment", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith("pi_test123")
    })

    it("transitions payment status to canceled", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockTransitionStatus).toHaveBeenCalledWith("pay_01", {
        newStatus: "canceled",
        actor: "customer",
        actorId: CTX.customerId,
        reason: "order_canceled",
        expectedVersion: 3,
      })
    })

    it("publishes payment.status_changed NATS event", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockPublishNatsEvent).toHaveBeenCalledWith(
        "payment.status_changed",
        expect.objectContaining({
          orderId: INPUT.orderId,
          paymentId: "pay_01",
          previousStatus: "awaiting_payment",
          newStatus: "canceled",
          method: "pix",
          version: 4,
        }),
      )
    })

    it("returns the success result from the order service", async () => {
      const result = await cancelOrder(INPUT, CTX)

      expect(result).toEqual({ success: true, message: "Pedido cancelado com sucesso." })
    })
  })

  describe("payment already in terminal status", () => {
    beforeEach(() => {
      mockCancelOrder.mockResolvedValue({ success: true, message: "Pedido cancelado com sucesso." })
    })

    it("skips transitionStatus when payment is already canceled", async () => {
      mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "canceled" }))

      await cancelOrder(INPUT, CTX)

      expect(mockTransitionStatus).not.toHaveBeenCalled()
    })

    it("skips transitionStatus when payment is paid", async () => {
      mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "paid" }))

      await cancelOrder(INPUT, CTX)

      expect(mockTransitionStatus).not.toHaveBeenCalled()
    })

    it("skips transitionStatus when payment is refunded", async () => {
      mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "refunded" }))

      await cancelOrder(INPUT, CTX)

      expect(mockTransitionStatus).not.toHaveBeenCalled()
    })

    it("does not publish payment.status_changed when payment is terminal", async () => {
      mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "canceled" }))

      await cancelOrder(INPUT, CTX)

      expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
        "payment.status_changed",
        expect.anything(),
      )
    })

    it("still returns success even when payment is terminal", async () => {
      mockGetActiveByOrderId.mockResolvedValue(makePayment({ status: "canceled" }))

      const result = await cancelOrder(INPUT, CTX)

      expect(result.success).toBe(true)
    })
  })

  describe("no active payment exists", () => {
    beforeEach(() => {
      mockCancelOrder.mockResolvedValue({ success: true, message: "Pedido cancelado com sucesso." })
      mockGetActiveByOrderId.mockResolvedValue(null)
    })

    it("still cancels the order even when there is no active payment", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockCancelOrder).toHaveBeenCalledWith(INPUT.orderId, CTX.customerId)
    })

    it("does not call transitionStatus when there is no active payment", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockTransitionStatus).not.toHaveBeenCalled()
    })

    it("does not publish payment.status_changed when there is no active payment", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
        "payment.status_changed",
        expect.anything(),
      )
    })

    it("returns success when there is no active payment", async () => {
      const result = await cancelOrder(INPUT, CTX)

      expect(result).toEqual({ success: true, message: "Pedido cancelado com sucesso." })
    })
  })

  describe("not authenticated", () => {
    it("throws NonRetryableError when customerId is missing", async () => {
      const guestCtx = makeGuestCtx()

      await expect(cancelOrder(INPUT, guestCtx)).rejects.toThrow(NonRetryableError)
    })

    it("throws with pt-BR auth message", async () => {
      const guestCtx = makeGuestCtx()

      await expect(cancelOrder(INPUT, guestCtx)).rejects.toThrow(
        "Autenticação necessária para cancelar pedido.",
      )
    })

    it("does not call the order service when unauthenticated", async () => {
      const guestCtx = makeGuestCtx()

      await cancelOrder(INPUT, guestCtx).catch(() => undefined)

      expect(mockCancelOrder).not.toHaveBeenCalled()
    })
  })

  describe("order not found / ownership invalid", () => {
    beforeEach(() => {
      mockCancelOrder.mockResolvedValue({
        success: false,
        message: "Pedido não encontrado ou não pertence a este cliente.",
      })
    })

    it("returns success: false", async () => {
      const result = await cancelOrder(INPUT, CTX)

      expect(result.success).toBe(false)
    })

    it("does not attempt payment cancellation when order lookup fails", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockGetActiveByOrderId).not.toHaveBeenCalled()
      expect(mockTransitionStatus).not.toHaveBeenCalled()
    })

    it("does not publish payment.status_changed when order is not found", async () => {
      await cancelOrder(INPUT, CTX)

      expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
        "payment.status_changed",
        expect.anything(),
      )
    })

    it("returns the message from the order service", async () => {
      const result = await cancelOrder(INPUT, CTX)

      expect(result.message).toBe("Pedido não encontrado ou não pertence a este cliente.")
    })
  })
})
