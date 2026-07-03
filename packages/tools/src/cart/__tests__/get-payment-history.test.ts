// Tests for get_payment_history tool — BKL-071: the billing counterpart of
// get_order_history, owner-scoped over the customer's whole payment history.
// Mock-based; no database or network required.
//
// PAYMENT is a customer_scoped domain — a `Payment` row carries no customerId,
// so ownership is the parent order's customerId, resolved by the
// `listByCustomer` join (`where: { order: { customerId } }`). A
// `customerId: undefined` in that join is a NO-OP filter → it would return
// EVERY customer's payments. The handler therefore MUST refuse an
// unauthenticated session BEFORE any query (Inv 2 "no owner ≠ any owner").
//
// Scenarios:
//   1. unauthenticated (no ctx.customerId) → REFUSED, query never reached (IDOR).
//   2. authenticated → query is scoped to ctx.customerId (never a model id).
//   3. owner-scoped projection maps the billing fields + pt-BR label and NEVER
//      leaks stripePaymentIntentId.
//   4. terminal-status rows (refunded/failed) are included — this is history,
//      not the active-payment lookup.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { getPaymentHistory } from "../get-payment-history.js"
import { makeCtx, makeGuestCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

// Payment read boundaries — must NOT be reached for an unauthenticated caller.
const mockListByCustomer = vi.hoisted(() => vi.fn())
const mockCountByCustomer = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  createPaymentQueryService: () => ({
    listByCustomer: mockListByCustomer,
    countByCustomer: mockCountByCustomer,
  }),
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = {} as Record<string, never>
const CTX = makeCtx() // customerId: "cus_01"

/** A representative payment row as returned by paymentQueryService.listByCustomer. */
function paymentRow(over: Record<string, unknown> = {}) {
  return {
    id: "pay_01",
    orderId: "order_01",
    method: "pix",
    status: "paid",
    amountInCentavos: 26700,
    refundedAmountCentavos: 0,
    // Must NEVER surface in the projection:
    stripePaymentIntentId: "pi_secret_LEAK",
    pixExpiresAt: new Date("2026-06-24T18:00:00.000Z"),
    createdAt: new Date("2026-06-24T17:00:00.000Z"),
    ...over,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getPaymentHistory — owner-scoped billing history (BKL-071)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 1. IDOR guard: an unauthenticated session is refused, and NEITHER query —
  //    the place `customerId: undefined` would leak the whole table — is run.
  it("REFUSES an unauthenticated session and NEVER queries (IDOR guard)", async () => {
    await expect(getPaymentHistory(INPUT, makeGuestCtx())).rejects.toThrow(
      "Autenticação necessária",
    )
    expect(mockListByCustomer).not.toHaveBeenCalled()
    expect(mockCountByCustomer).not.toHaveBeenCalled()
  })

  // 2. The query is scoped to the AUTHENTICATED customerId (never a model id) and
  //    the page is BOUNDED to 6 rows (enrichment-cap safety).
  it("scopes both queries to ctx.customerId and bounds the page to 6", async () => {
    mockListByCustomer.mockResolvedValue([])
    mockCountByCustomer.mockResolvedValue(0)

    const result = await getPaymentHistory(INPUT, CTX)

    expect(mockListByCustomer).toHaveBeenCalledWith("cus_01", { limit: 6 })
    expect(mockCountByCustomer).toHaveBeenCalledWith("cus_01")
    expect(result).toEqual({ totalCount: 0, count: 0, payments: [] })
  })

  // 3. Owner-scoped projection — billing fields + pt-BR label, no raw secrets;
  //    totalCount present so the render can be honest ("K de N").
  it("projects the billing fields with a pt-BR label and NEVER leaks the Stripe PI id", async () => {
    mockListByCustomer.mockResolvedValue([paymentRow()])
    mockCountByCustomer.mockResolvedValue(1)

    const result = await getPaymentHistory(INPUT, CTX)

    expect(result).toEqual({
      totalCount: 1,
      count: 1,
      payments: [
        {
          id: "pay_01",
          orderId: "order_01",
          method: "pix",
          status: "paid",
          statusLabel: "Pago",
          amountInCentavos: 26700,
          refundedAmountCentavos: 0,
          pixExpiresAt: "2026-06-24T18:00:00.000Z",
          createdAt: "2026-06-24T17:00:00.000Z",
        },
      ],
    })
    // Belt-and-suspenders: the raw Stripe PI id never escapes anywhere.
    expect(JSON.stringify(result)).not.toContain("pi_secret_LEAK")
  })

  // 3b. totalCount is the honest total behind the bounded page (K of N) — and it
  //     is serialized BEFORE payments so it survives the enrichment-cap truncation.
  it("reports totalCount ≥ count when the history exceeds the page, counts first", async () => {
    mockListByCustomer.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => paymentRow({ id: `pay_0${i}` })),
    )
    mockCountByCustomer.mockResolvedValue(20)

    const result = await getPaymentHistory(INPUT, CTX)

    expect(result.count).toBe(6)
    expect(result.totalCount).toBe(20)
    // Counts precede the (truncatable) payments array in the serialized JSON.
    const json = JSON.stringify(result)
    expect(json.indexOf('"totalCount"')).toBeLessThan(json.indexOf('"payments"'))
    expect(json.indexOf('"count"')).toBeLessThan(json.indexOf('"payments"'))
  })

  // 4. Terminal statuses are included — history must show settled/refunded/failed.
  it("includes TERMINAL-status payments (refunded/failed) — history, not active-only", async () => {
    mockListByCustomer.mockResolvedValue([
      paymentRow({ id: "pay_refunded", status: "refunded", refundedAmountCentavos: 26700 }),
      paymentRow({ id: "pay_failed", status: "payment_failed", pixExpiresAt: null }),
    ])
    mockCountByCustomer.mockResolvedValue(2)

    const result = await getPaymentHistory(INPUT, CTX)

    expect(result.count).toBe(2)
    expect(result.payments.map((p) => p.status)).toEqual(["refunded", "payment_failed"])
    expect(result.payments[0]!.statusLabel).toBe("Reembolsado")
    expect(result.payments[1]!.pixExpiresAt).toBeNull()
  })
})
