// OrderService.capturePayment — stale-PI guard regression (P0-PAY-1, audit-2026-05-27).
//
// Two regressions this pins, both lost in the claustrum-on-dev cutover:
//
//  1. CENTAVOS vs REAIS. Medusa v2 returns `order.total` in reais (e.g. 89 for
//     R$89,00); Stripe's PaymentIntent.amount (passed as `amountInCentavos`) is the
//     minor unit (8900). The stale-PI guard must convert before comparing —
//     `amountInCentavos !== Math.round(order.total * 100)`. The pre-fix
//     `!== order.total` mismatched for every order > R$0,01, so capturePayment
//     silently returned null and the capture POST + order.placed publish never ran
//     (customer charged, order stranded in `pending`). CLAUDE.md rule #2.
//
//  2. MEDUSA v2 FIELD SELECTION. v2 rejects the v1 `?expand=` query param with
//     400 "Unrecognized fields: 'expand'"; the order GET must use the `?fields=`
//     idiom. With `?expand=` the GET threw before any capture ran.
//
// T2-1 contract update (gap `medusa-v2-capture-payment`): the
// `POST /admin/orders/:id/capture-payment` mutate was a REMOVED Medusa v1
// endpoint (404 on every call — the D-015 dead-v1-endpoint class), so
// capturePayment now issues exactly ONE mutation — the v2-valid metadata
// stamp (`POST /admin/orders/:id`) — and the Medusa-side capture bookkeeping
// is skipped with a loud gap-named log until ported to /admin/payments.
// The stale-PI guard semantics (what this file pins) are unchanged.
//
// Mirrors the DI mocking in order-service-egress.test.ts: fetchAdmin for the GET,
// adminAdjudicated for the metadata mutation.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createOrderService, type AdminAdjudicated } from "../order.service.js"

describe("OrderService.capturePayment — stale-PI guard (P0-PAY-1)", () => {
  let fetchAdmin: ReturnType<typeof vi.fn>
  let adminAdjudicated: ReturnType<typeof vi.fn>

  const pendingOrder = (total: number) => ({
    order: {
      id: "order_01",
      status: "pending",
      display_id: 1001,
      total, // reais (Medusa v2)
      subtotal: total,
      shipping_total: 0,
      items: [{ id: "li_1", title: "Costela", quantity: 1, unit_price: total, variant_id: "var_1" }],
      customer_id: "cust_01",
      metadata: {},
      email: "test@example.com",
      customer: { first_name: "Test" },
    },
  })

  beforeEach(() => {
    fetchAdmin = vi.fn()
    adminAdjudicated = vi.fn().mockResolvedValue({})
  })

  const svc = () =>
    createOrderService(fetchAdmin, {
      adminAdjudicated: adminAdjudicated as unknown as AdminAdjudicated,
    })

  it("captures an R$89,00 order when amountInCentavos (8900) matches total in centavos", async () => {
    fetchAdmin.mockResolvedValueOnce(pendingOrder(89)) // R$89,00

    const result = await svc().capturePayment("order_01", "pi_123", { amountInCentavos: 8900 })

    expect(result).not.toBeNull()
    // The metadata-stamp POST MUST have been issued (pre-fix: 8900 !== 89 →
    // returned null before ANY mutation). T2-1: exactly one mutate — the dead
    // v1 capture POST is gone (gap medusa-v2-capture-payment).
    expect(adminAdjudicated).toHaveBeenCalledTimes(1)
    expect(adminAdjudicated.mock.calls[0][0].path).toBe("/admin/orders/order_01")
  })

  it("captures a fractional total R$89,90 (Math.round absorbs the IEEE-754 artifact)", async () => {
    fetchAdmin.mockResolvedValueOnce(pendingOrder(89.9)) // 89.9 * 100 = 8989.9999… → round 8990

    const result = await svc().capturePayment("order_01", "pi_123", { amountInCentavos: 8990 })

    expect(result).not.toBeNull()
    expect(adminAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/admin/orders/order_01" }),
    )
  })

  it("skips (returns null, no mutation) on a genuine amount mismatch — stale PI after amendment", async () => {
    fetchAdmin.mockResolvedValueOnce(pendingOrder(89)) // 8900 centavos

    const result = await svc().capturePayment("order_01", "pi_123", { amountInCentavos: 9000 })

    expect(result).toBeNull()
    expect(adminAdjudicated).not.toHaveBeenCalled()
  })

  it("captures when no amountInCentavos is supplied (guard skipped)", async () => {
    fetchAdmin.mockResolvedValueOnce(pendingOrder(89))

    const result = await svc().capturePayment("order_01", "pi_123")

    expect(result).not.toBeNull()
    expect(adminAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/admin/orders/order_01" }),
    )
  })

  it("fetches the order with the Medusa v2 `fields` idiom, never the v1 `expand` param", async () => {
    fetchAdmin.mockResolvedValueOnce(pendingOrder(89))

    await svc().capturePayment("order_01", "pi_123", { amountInCentavos: 8900 })

    const getPath = fetchAdmin.mock.calls[0][0] as string
    expect(getPath).toContain("fields=")
    expect(getPath).not.toContain("expand=")
  })
})
