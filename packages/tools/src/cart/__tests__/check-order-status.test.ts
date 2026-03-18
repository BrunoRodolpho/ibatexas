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

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}))

// ── Imports ──────────────────────────────────────────────────────────────────

import { checkOrderStatus } from "../check-order-status.js"
import { makeCtx, makeGuestCtx, orderResponse } from "./fixtures/medusa.js"

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

  it("calls correct admin endpoint", async () => {
    await checkOrderStatus(INPUT, CTX)

    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/orders/order_01?expand=items")
  })

  it("returns success:false when order belongs to different customer (LGPD)", async () => {
    mockMedusaAdmin.mockResolvedValue(
      orderResponse({ customer_id: "cus_OTHER" }),
    )

    const result = await checkOrderStatus(INPUT, CTX) as { success: boolean; message: string }

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido não encontrado.")
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

  it("returns success:false when metadata customerId does not match", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: {
        status: "pending",
        customer_id: undefined,
        metadata: { customerId: "cus_WRONG" },
      },
    })

    const result = await checkOrderStatus(INPUT, CTX) as { success: boolean; message: string }

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido não encontrado.")
  })

  it("allows access when neither customer_id nor metadata customerId set (legacy)", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: { status: "pending" },
    })

    const result = await checkOrderStatus(INPUT, CTX)

    // When orderCustomerId is falsy, the check is skipped
    expect(result).toEqual({ order: { status: "pending" } })
  })

  it("handles different order IDs", async () => {
    const input = { orderId: "order_99" }
    mockMedusaAdmin.mockResolvedValue(orderResponse({ id: "order_99", customer_id: "cus_01" }))

    await checkOrderStatus(input, CTX)

    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/orders/order_99?expand=items")
  })
})
