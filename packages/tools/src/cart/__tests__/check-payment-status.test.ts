// Tests for check_payment_status tool — N-P0.2: close the payment IDOR.
// Mock-based; no database or network required.
//
// PAYMENT_STATUS is a customer_scoped claim (claim-registry §6 Cluster D).
// `Payment` carries no customerId; ownership is reachable only via the
// OrderProjection join performed by the canonical assertOrderOwnership guard
// (Medusa /admin/orders/{id} → customer_id / metadata.customerId). The
// check_payment_status tool MUST assert order ownership BEFORE reading any
// payment, or any caller with an arbitrary orderId reads another customer's
// payment state (IDOR).
//
// Scenarios (SDD §N P0-2; Inv 2 "no owner ≠ any owner" → REFUSED; Inv 13
// tenant-isolation):
//   1. orderId NOT owned by ctx.customerId → REFUSED, no payment read at all.
//   2. owned orderId → returns the full 12-state payment projection (no regression).
//   3. no-owner order (null/absent attribution) → REFUSED (Inv 2).
//   4. NON-VACUITY: the payment query service is NEVER reached for (1)/(3);
//      its result, if reached, would otherwise be returned cross-customer.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { checkPaymentStatus } from "../check-payment-status.js"
import { makeCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

// Ownership join boundary — assertOrderOwnership → medusaAdminFetch → medusaAdmin.
const mockMedusaAdmin = vi.hoisted(() => vi.fn())
// Payment read boundary — must NOT be reached for non-owners.
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockListByOrderId = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
  medusaStore: vi.fn(),
}))

vi.mock("@ibatexas/domain", () => ({
  createPaymentQueryService: () => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    listByOrderId: mockListByOrderId,
  }),
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = { orderId: "order_01" }
const CTX = makeCtx() // customerId: "cus_01"

/** An owner-scoped order owned by cus_01 (the caller). */
function ownedOrderResponse() {
  return { order: { id: "order_01", customer_id: "cus_01", metadata: {} } }
}

/** An order owned by a DIFFERENT customer — the IDOR target. */
function otherCustomerOrderResponse() {
  return { order: { id: "order_01", customer_id: "cus_OTHER", metadata: {} } }
}

/** An order with NO owner attribution at all (Inv 2: "no owner" ≠ "any owner"). */
function noOwnerOrderResponse() {
  return { order: { id: "order_01", customer_id: undefined, metadata: {} } }
}

/** A representative active payment using one of the 12 PaymentStatus states. */
function activePixPayment() {
  return {
    id: "pay_01",
    method: "pix",
    status: "payment_pending",
    amountInCentavos: 26700,
    pixExpiresAt: new Date("2026-06-24T18:00:00.000Z"),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("checkPaymentStatus — payment IDOR closed (N-P0.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 1. Cross-customer orderId → REFUSED, and the payment store is never touched.
  it("REFUSES a payment read for an order owned by a different customer (Inv 13)", async () => {
    mockMedusaAdmin.mockResolvedValue(otherCustomerOrderResponse())

    await expect(checkPaymentStatus(INPUT, CTX)).rejects.toThrow("Acesso negado")

    // No payment data may leak: the query service is never reached.
    expect(mockGetActiveByOrderId).not.toHaveBeenCalled()
    expect(mockListByOrderId).not.toHaveBeenCalled()
  })

  // 2. Owned order → returns the full 12-state payment projection unchanged.
  it("returns the payment projection for an owned order (no regression, 12-state intact)", async () => {
    mockMedusaAdmin.mockResolvedValue(ownedOrderResponse())
    mockGetActiveByOrderId.mockResolvedValue(activePixPayment())
    mockListByOrderId.mockResolvedValue({ payments: [activePixPayment(), activePixPayment()] })

    const result = await checkPaymentStatus(INPUT, CTX)

    expect(result).toEqual({
      hasPayment: true,
      paymentId: "pay_01",
      method: "pix",
      status: "payment_pending",
      statusLabel: expect.any(String),
      amountInCentavos: 26700,
      pixExpiresAt: "2026-06-24T18:00:00.000Z",
      isTerminal: false,
      canRetry: false,
      canRegenPix: false,
      canSwitchMethod: true,
      attemptCount: 2,
    })
    // Ownership was asserted against the OrderProjection join BEFORE any read.
    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/orders/order_01")
    expect(mockGetActiveByOrderId).toHaveBeenCalledWith("order_01")
  })

  // 2b. A terminal/no-active owned order still returns its historical projection.
  it("returns historical payment for an owned order with no active payment", async () => {
    mockMedusaAdmin.mockResolvedValue(ownedOrderResponse())
    mockGetActiveByOrderId.mockResolvedValue(null)
    mockListByOrderId.mockResolvedValue({ payments: [{ status: "refunded" }] })

    const result = await checkPaymentStatus(INPUT, CTX)

    expect(result).toEqual({ hasPayment: true, status: "refunded", isTerminal: true })
  })

  // 3. No-owner order → REFUSED (Inv 2: "no owner" ≠ "any owner").
  it("REFUSES a payment read for an order with no owner attribution (Inv 2)", async () => {
    mockMedusaAdmin.mockResolvedValue(noOwnerOrderResponse())

    await expect(checkPaymentStatus(INPUT, CTX)).rejects.toThrow("Acesso negado")

    expect(mockGetActiveByOrderId).not.toHaveBeenCalled()
    expect(mockListByOrderId).not.toHaveBeenCalled()
  })

  // 3b. A nonexistent order → REFUSED (the guard throws "Pedido não encontrado").
  it("REFUSES when the order does not exist", async () => {
    mockMedusaAdmin.mockResolvedValue({ order: undefined })

    await expect(checkPaymentStatus(INPUT, CTX)).rejects.toThrow("Pedido não encontrado")

    expect(mockGetActiveByOrderId).not.toHaveBeenCalled()
  })

  // 4. NON-VACUITY anchor: if the guard were absent, the SAME cross-customer /
  //    no-owner inputs would return a payment projection. This test pins the
  //    payment that WOULD leak, proving tests (1)/(3) are non-vacuous: the
  //    payment store is fully stubbed to succeed, yet no data escapes because
  //    the ownership guard short-circuits first. (If the strict-by-default
  //    ownership guard were removed, (1)/(3) go RED — the read succeeds and
  //    returns this.)
  it("non-vacuity: a fully-stubbed payment read still never escapes the guard for a non-owner", async () => {
    mockMedusaAdmin.mockResolvedValue(otherCustomerOrderResponse())
    mockGetActiveByOrderId.mockResolvedValue(activePixPayment())
    mockListByOrderId.mockResolvedValue({ payments: [activePixPayment()] })

    await expect(checkPaymentStatus(INPUT, CTX)).rejects.toThrow("Acesso negado")
    expect(mockGetActiveByOrderId).not.toHaveBeenCalled()
  })
})
