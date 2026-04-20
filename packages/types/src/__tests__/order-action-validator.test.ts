import { describe, it, expect } from "vitest"
import { canPerformAction, type ActionContext } from "../order-action-validator.js"
import type { OrderFulfillmentStatus } from "../order-status.js"
import type { PaymentStatus } from "../payment-status.js"

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    fulfillmentStatus: "pending" as OrderFulfillmentStatus,
    ...overrides,
  }
}

describe("canPerformAction", () => {
  // ── cancel_order ────────────────────────────────────────────────────
  describe("cancel_order", () => {
    it("allows cancel on pending within PONR", () => {
      expect(canPerformAction("cancel_order", ctx()).allowed).toBe(true)
    })

    it("allows cancel on confirmed within PONR", () => {
      expect(canPerformAction("cancel_order", ctx({ fulfillmentStatus: "confirmed" })).allowed).toBe(true)
    })

    it("denies cancel on preparing with escalation", () => {
      const result = canPerformAction("cancel_order", ctx({ fulfillmentStatus: "preparing" }))
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.escalate).toBe(true)
    })

    it("denies cancel on ready", () => {
      expect(canPerformAction("cancel_order", ctx({ fulfillmentStatus: "ready" })).allowed).toBe(false)
    })

    it("denies cancel on in_delivery", () => {
      expect(canPerformAction("cancel_order", ctx({ fulfillmentStatus: "in_delivery" })).allowed).toBe(false)
    })

    it("denies cancel on delivered", () => {
      expect(canPerformAction("cancel_order", ctx({ fulfillmentStatus: "delivered" })).allowed).toBe(false)
    })

    it("denies cancel on already canceled", () => {
      expect(canPerformAction("cancel_order", ctx({ fulfillmentStatus: "canceled" })).allowed).toBe(false)
    })

    it("denies cancel past PONR with escalation", () => {
      const result = canPerformAction("cancel_order", ctx({
        orderCreatedAt: new Date(Date.now() - 60 * 60_000), // 60 min ago
        ponrMinutes: 5,
      }))
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.escalate).toBe(true)
    })
  })

  // ── amend_add_item ──────────────────────────────────────────────────
  describe("amend_add_item", () => {
    it("allows on pending", () => {
      expect(canPerformAction("amend_add_item", ctx()).allowed).toBe(true)
    })

    it("allows on confirmed", () => {
      expect(canPerformAction("amend_add_item", ctx({ fulfillmentStatus: "confirmed" })).allowed).toBe(true)
    })

    it("allows on preparing (no PONR for adds)", () => {
      expect(canPerformAction("amend_add_item", ctx({ fulfillmentStatus: "preparing" })).allowed).toBe(true)
    })

    it("denies on ready", () => {
      expect(canPerformAction("amend_add_item", ctx({ fulfillmentStatus: "ready" })).allowed).toBe(false)
    })

    it("denies on canceled", () => {
      expect(canPerformAction("amend_add_item", ctx({ fulfillmentStatus: "canceled" })).allowed).toBe(false)
    })
  })

  // ── amend_remove_item ────────────────────────────────────────────────
  describe("amend_remove_item", () => {
    it("allows on pending within PONR", () => {
      expect(canPerformAction("amend_remove_item", ctx()).allowed).toBe(true)
    })

    it("escalates on preparing", () => {
      const result = canPerformAction("amend_remove_item", ctx({ fulfillmentStatus: "preparing" }))
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.escalate).toBe(true)
    })

    it("denies past PONR with escalation", () => {
      const result = canPerformAction("amend_remove_item", ctx({
        orderCreatedAt: new Date(Date.now() - 60 * 60_000),
        ponrMinutes: 5,
      }))
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.escalate).toBe(true)
    })
  })

  // ── change_payment_method ───────────────────────────────────────────
  describe("change_payment_method", () => {
    it("allows when awaiting_payment", () => {
      expect(canPerformAction("change_payment_method", ctx({
        paymentStatus: "awaiting_payment" as PaymentStatus,
      })).allowed).toBe(true)
    })

    it("allows when payment_pending", () => {
      expect(canPerformAction("change_payment_method", ctx({
        paymentStatus: "payment_pending" as PaymentStatus,
      })).allowed).toBe(true)
    })

    it("allows when payment_expired", () => {
      expect(canPerformAction("change_payment_method", ctx({
        paymentStatus: "payment_expired" as PaymentStatus,
      })).allowed).toBe(true)
    })

    it("allows when cash_pending", () => {
      expect(canPerformAction("change_payment_method", ctx({
        paymentStatus: "cash_pending" as PaymentStatus,
      })).allowed).toBe(true)
    })

    it("denies when paid", () => {
      expect(canPerformAction("change_payment_method", ctx({
        paymentStatus: "paid" as PaymentStatus,
      })).allowed).toBe(false)
    })

    it("denies when refunded", () => {
      expect(canPerformAction("change_payment_method", ctx({
        paymentStatus: "refunded" as PaymentStatus,
      })).allowed).toBe(false)
    })

    it("blocks cash for delivery orders", () => {
      const result = canPerformAction("change_payment_method", ctx({
        paymentStatus: "awaiting_payment" as PaymentStatus,
        orderType: "delivery",
        newPaymentMethod: "cash",
      }))
      expect(result.allowed).toBe(false)
    })

    it("allows cash for pickup orders", () => {
      expect(canPerformAction("change_payment_method", ctx({
        paymentStatus: "awaiting_payment" as PaymentStatus,
        orderType: "pickup",
        newPaymentMethod: "cash",
      })).allowed).toBe(true)
    })
  })

  // ── retry_payment ───────────────────────────────────────────────────
  describe("retry_payment", () => {
    it("allows when payment_failed", () => {
      expect(canPerformAction("retry_payment", ctx({
        paymentStatus: "payment_failed" as PaymentStatus,
      })).allowed).toBe(true)
    })

    it("allows when payment_expired", () => {
      expect(canPerformAction("retry_payment", ctx({
        paymentStatus: "payment_expired" as PaymentStatus,
      })).allowed).toBe(true)
    })

    it("denies when paid", () => {
      expect(canPerformAction("retry_payment", ctx({
        paymentStatus: "paid" as PaymentStatus,
      })).allowed).toBe(false)
    })

    it("denies when payment_pending", () => {
      expect(canPerformAction("retry_payment", ctx({
        paymentStatus: "payment_pending" as PaymentStatus,
      })).allowed).toBe(false)
    })
  })

  // ── regenerate_pix ──────────────────────────────────────────────────
  describe("regenerate_pix", () => {
    it("allows when PIX and payment_expired", () => {
      expect(canPerformAction("regenerate_pix", ctx({
        paymentStatus: "payment_expired" as PaymentStatus,
        paymentMethod: "pix",
      })).allowed).toBe(true)
    })

    it("denies for non-PIX method", () => {
      expect(canPerformAction("regenerate_pix", ctx({
        paymentStatus: "payment_expired" as PaymentStatus,
        paymentMethod: "card",
      })).allowed).toBe(false)
    })

    it("denies when PIX is still pending", () => {
      expect(canPerformAction("regenerate_pix", ctx({
        paymentStatus: "payment_pending" as PaymentStatus,
        paymentMethod: "pix",
      })).allowed).toBe(false)
    })
  })

  // ── add_notes ───────────────────────────────────────────────────────
  describe("add_notes", () => {
    it("allows on most statuses", () => {
      const statuses: OrderFulfillmentStatus[] = ["pending", "confirmed", "preparing", "ready", "in_delivery", "delivered"]
      for (const s of statuses) {
        expect(canPerformAction("add_notes", ctx({ fulfillmentStatus: s })).allowed).toBe(true)
      }
    })

    it("denies on canceled", () => {
      expect(canPerformAction("add_notes", ctx({ fulfillmentStatus: "canceled" })).allowed).toBe(false)
    })
  })

  // ── change_delivery_address ─────────────────────────────────────────
  describe("change_delivery_address", () => {
    it("allows on pending delivery within PONR", () => {
      expect(canPerformAction("change_delivery_address", ctx({
        orderType: "delivery",
      })).allowed).toBe(true)
    })

    it("denies for pickup orders", () => {
      expect(canPerformAction("change_delivery_address", ctx({
        orderType: "pickup",
      })).allowed).toBe(false)
    })

    it("denies on ready", () => {
      expect(canPerformAction("change_delivery_address", ctx({
        fulfillmentStatus: "ready",
        orderType: "delivery",
      })).allowed).toBe(false)
    })
  })

  // ── switch_order_type ───────────────────────────────────────────────
  describe("switch_order_type", () => {
    it("allows on pending within PONR", () => {
      expect(canPerformAction("switch_order_type", ctx()).allowed).toBe(true)
    })

    it("escalates on confirmed", () => {
      const result = canPerformAction("switch_order_type", ctx({ fulfillmentStatus: "confirmed" }))
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.escalate).toBe(true)
    })

    it("denies on preparing", () => {
      expect(canPerformAction("switch_order_type", ctx({ fulfillmentStatus: "preparing" })).allowed).toBe(false)
    })
  })
})
