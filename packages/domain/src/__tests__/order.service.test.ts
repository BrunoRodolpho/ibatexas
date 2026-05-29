// Tests for OrderService.capturePayment — the stale-PI guard (P0-PAY-1, RC-A2).
// Mock-based; the Medusa admin fetch is injected, so no DB or network.
//
// Regression focus: the guard compares the Stripe minor unit (centavos) against
// order.total, which Medusa v2 returns in reais. The pre-fix `!== order.total`
// mismatched for every order > R$0,01, so capturePayment silently returned null
// and no order was ever captured/placed. The fix converts to centavos before
// comparing (CLAUDE.md rule #2: integer centavos, never reais-vs-centavos).

import { describe, it, expect, vi } from "vitest"
import { createOrderService, type MedusaOrder } from "../services/order.service.js"

/**
 * Build a mock medusaAdmin fn that returns `order` for the expand GET and
 * resolves `{}` for the capture + metadata POSTs. Returns the spy so tests can
 * assert whether the capture POST was issued.
 */
function makeFetch(order: Partial<MedusaOrder>) {
  return vi.fn(async (path: string, options?: RequestInit) => {
    if (!options || options.method === undefined) {
      // GET (fetch order)
      return { order: { id: "order_1", status: "pending", metadata: {}, items: [], display_id: 1, ...order } }
    }
    // POST (capture-payment / metadata update)
    return {}
  })
}

describe("OrderService.capturePayment — off-by-100 stale-PI guard (P0-PAY-1)", () => {
  it("captures an R$89,00 order when amountInCentavos (8900) matches total (89 reais)", async () => {
    const fetch = makeFetch({ total: 89 })
    const svc = createOrderService(fetch)

    const result = await svc.capturePayment("order_1", "pi_123", { amountInCentavos: 8900 })

    expect(result).not.toBeNull()
    expect(result?.totalInCentavos).toBe(8900)
    // capture POST must have been issued
    expect(fetch).toHaveBeenCalledWith("/admin/orders/order_1/capture-payment", { method: "POST" })
  })

  it("captures with BRL fractional total (R$89,90) — Math.round absorbs float artifact", async () => {
    const fetch = makeFetch({ total: 89.9 })
    const svc = createOrderService(fetch)

    // 89.9 * 100 = 8989.9999... in IEEE754 → Math.round → 8990
    const result = await svc.capturePayment("order_1", "pi_123", { amountInCentavos: 8990 })

    expect(result).not.toBeNull()
    expect(fetch).toHaveBeenCalledWith("/admin/orders/order_1/capture-payment", { method: "POST" })
  })

  it("skips (returns null) on a genuine amount mismatch — stale PI after amendment", async () => {
    const fetch = makeFetch({ total: 89 }) // 8900 centavos
    const svc = createOrderService(fetch)

    const result = await svc.capturePayment("order_1", "pi_123", { amountInCentavos: 9000 })

    expect(result).toBeNull()
    // capture POST must NOT have been issued
    expect(fetch).not.toHaveBeenCalledWith("/admin/orders/order_1/capture-payment", { method: "POST" })
  })

  it("captures when no amountInCentavos is supplied (guard skipped)", async () => {
    const fetch = makeFetch({ total: 89 })
    const svc = createOrderService(fetch)

    const result = await svc.capturePayment("order_1", "pi_123")

    expect(result).not.toBeNull()
    expect(fetch).toHaveBeenCalledWith("/admin/orders/order_1/capture-payment", { method: "POST" })
  })
})
