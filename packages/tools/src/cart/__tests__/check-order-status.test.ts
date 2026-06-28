// Tests for check_order_status tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns order data
// - Missing auth → throws with pt-BR message
// - Wrong customer → {success: false, message: "Pedido não encontrado."}
// - Medusa error → throws (propagates upstream)
// - LGPD: customer_id in metadata fallback

import { describe, it, expect, beforeEach, vi } from "vitest"
import { checkOrderStatus } from "../check-order-status.js"
import { makeCtx, makeGuestCtx, orderResponse } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = { orderId: "order_01" }
const CTX = makeCtx()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("checkOrderStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaAdmin.mockResolvedValue(orderResponse({ customer_id: "cus_01" }))
  })

  it("throws when customerId is missing (no auth)", async () => {
    const guestCtx = makeGuestCtx()

    await expect(checkOrderStatus(INPUT, guestCtx)).rejects.toThrow("Autenticação necessária")
  })

  it("returns order data on happy path", async () => {
    const mockResponse = orderResponse({ customer_id: "cus_01", status: "pending" })
    mockMedusaAdmin.mockResolvedValue(mockResponse)

    const result = await checkOrderStatus(INPUT, CTX)

    // Source returns { order } after domain extracts .order from fetch response
    expect(result).toEqual({ order: mockResponse.order })
  })

  it("calls admin endpoint for ownership guard and domain service", async () => {
    await checkOrderStatus(INPUT, CTX)

    // SEC-002 guard and domain service both call without expand
    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/orders/order_01")
    expect(mockMedusaAdmin).toHaveBeenCalledTimes(2)
  })

  it("throws 'Acesso negado' when order belongs to different customer (SEC-002)", async () => {
    mockMedusaAdmin.mockResolvedValue(
      orderResponse({ customer_id: "cus_OTHER" }),
    )

    await expect(checkOrderStatus(INPUT, CTX)).rejects.toThrow("Acesso negado")
  })

  it("throws when Medusa fetch fails", async () => {
    mockMedusaAdmin.mockRejectedValue(new Error("Medusa 500"))

    await expect(checkOrderStatus(INPUT, CTX)).rejects.toThrow("Medusa 500")
  })

  it("allows access when customer_id is in metadata", async () => {
    const mockResponse = {
      order: {
        status: "pending",
        customer_id: undefined,
        metadata: { customerId: "cus_01" },
      },
    }
    mockMedusaAdmin.mockResolvedValue(mockResponse)

    const result = await checkOrderStatus(INPUT, CTX)

    expect(result).toEqual({ order: mockResponse.order })
  })

  it("throws 'Acesso negado' when metadata customerId does not match (SEC-002)", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: {
        status: "pending",
        customer_id: undefined,
        metadata: { customerId: "cus_WRONG" },
      },
    })

    await expect(checkOrderStatus(INPUT, CTX)).rejects.toThrow("Acesso negado")
  })

  it("REFUSES access when neither customer_id nor metadata customerId set (R0b strict-by-default, Inv 2)", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { status: "pending" },
    })

    // R0b: an unowned order is "no owner" → REFUSED for this customer-facing
    // read. check_order_status gets the inverted strict default for free; we do
    // NOT add an `allowUnowned` escape hatch to a customer path (that would
    // re-open the IDOR the guard now closes — Inv 2 "no owner" ≠ "any owner").
    // NON-VACUOUS: under the old lenient default this returned the order.
    await expect(checkOrderStatus(INPUT, CTX)).rejects.toThrow("Acesso negado")
  })

  it("handles different order IDs", async () => {
    const input = { orderId: "order_99" }
    mockMedusaAdmin.mockResolvedValue(orderResponse({ id: "order_99", customer_id: "cus_01" }))

    await checkOrderStatus(input, CTX)

    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/orders/order_99")
    expect(mockMedusaAdmin).toHaveBeenCalledTimes(2)
  })
})
