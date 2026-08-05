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
import { NonRetryableError } from "@ibatexas/types"
import { cancelOrder } from "../cancel-order.js"
import { makeCtx, makeGuestCtx, orderResponse } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockCancelOrder = vi.hoisted(() => vi.fn())
const mockGetOrder = vi.hoisted(() => vi.fn())
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockTransitionStatus = vi.hoisted(() => vi.fn())
// R1-DELETE: cancel-order now dispatches through transitionStatusFromEnvelope.
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn())
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
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
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
    // R1-DELETE: envelope-typed cancel returns AdjudicatedResult shape.
    mockTransitionStatusFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 4, previousStatus: "awaiting_payment", newStatus: "canceled" },
    })
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

    it("[R1-DELETE] transitions payment via envelope (NOT bare-arg)", async () => {
      await cancelOrder(INPUT, CTX)

      // The envelope-typed entry point was called.
      expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledTimes(1)
      const envelope = mockTransitionStatusFromEnvelope.mock.calls[0]![0] as {
        kind: string;
        taint: string;
        payload: { paymentId: string; newStatus: string; actor: string; reason: string; expectedVersion?: number };
      }
      expect(envelope.kind).toBe("payment.status.transition")
      expect(envelope.taint).toBe("TRUSTED")
      expect(envelope.payload.paymentId).toBe("pay_01")
      expect(envelope.payload.newStatus).toBe("canceled")
      expect(envelope.payload.actor).toBe("customer")
      expect(envelope.payload.reason).toBe("order_canceled")
      expect(envelope.payload.expectedVersion).toBe(3)
      // Bare-arg path is NOT used.
      expect(mockTransitionStatus).not.toHaveBeenCalled()
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

  // ── F-48 — the escalation path reaches STAFF ────────────────────────────────
  //
  // `svc.cancelOrder` sets needsEscalation on its past-PONR refusal, whose
  // customer copy is "Prazo para cancelamento automático já passou. Um
  // atendente foi notificado e vai ajudar." This publish used to go to
  // `order.escalation_needed` — a subject with ZERO subscribers — so no
  // attendant was ever notified. It had NO test coverage at all before F-48.
  describe("escalation when the cancel PONR has expired (F-48)", () => {
    beforeEach(() => {
      mockCancelOrder.mockResolvedValue({
        success: false,
        needsEscalation: true,
        message:
          "Prazo para cancelamento automático já passou. Um atendente foi notificado e vai ajudar.",
      })
    })

    it("publishes support.handoff_requested so an attendant is actually notified", async () => {
      const result = await cancelOrder(INPUT, CTX)

      expect(result.needsEscalation).toBe(true)
      expect(mockPublishNatsEvent).toHaveBeenCalledWith("support.handoff_requested", {
        sessionId: "order-cancel-ponr:order_01",
        reason: "Cancelamento solicitado após o prazo de cancelamento — pedido order_01",
      })
    })

    it("never publishes the RETIRED subscriber-less order.escalation_needed subject", async () => {
      await cancelOrder(INPUT, CTX)

      const subjects = mockPublishNatsEvent.mock.calls.map((c: unknown[]) => c[0])
      expect(subjects).not.toContain("order.escalation_needed")
      expect(subjects).toContain("support.handoff_requested")
    })

    // The dedup key must NOT be BKL-103's `order-cancel:{orderId}`. That key
    // belongs to the HTTP paid-cancel escalation, which carries a park token an
    // OWNER approves. If this cheap notification-only escalation claimed it
    // first, the handoff-subscriber would return early on the later paid-cancel
    // event (7-day dedup TTL) — `appendPendingIntent` would never run and the
    // Approve button would silently never appear.
    it("does NOT collide with BKL-103's paid-cancel park/approval dedup key", async () => {
      await cancelOrder(INPUT, CTX)

      const call = mockPublishNatsEvent.mock.calls.find(
        (c: unknown[]) => c[0] === "support.handoff_requested",
      )
      const { sessionId } = call![1] as { sessionId: string }
      expect(sessionId).not.toBe("order-cancel:order_01")
    })

    it("does not escalate when the cancel succeeds", async () => {
      mockCancelOrder.mockResolvedValue({ success: true, message: "Pedido cancelado com sucesso." })

      await cancelOrder(INPUT, CTX)

      const subjects = mockPublishNatsEvent.mock.calls.map((c: unknown[]) => c[0])
      expect(subjects).not.toContain("support.handoff_requested")
    })
  })
})
