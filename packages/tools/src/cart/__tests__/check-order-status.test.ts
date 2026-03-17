// Tests for check_order_status tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns order data
// - Missing auth → throws with pt-BR message
// - Wrong customer → {success: false, message: "Pedido n\u00e3o encontrado."}
// - Medusa error → {success: false} with retry message
// - LGPD: customer_id in metadata fallback

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdminFetch = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaAdminFetch: mockMedusaAdminFetch,
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
    mockMedusaAdminFetch.mockResolvedValue(orderResponse({ customer_id: "cus_01" }))
  })

  it("throws when customerId is missing (no auth)", async () => {
    const guestCtx = makeGuestCtx()

    await expect(checkOrderStatus(INPUT, guestCtx)).rejects.toThrow("Autentica\u00e7\u00e3o necess\u00e1ria")
  })

  it("returns order data on happy path", async () => {
    const expected = orderResponse({ customer_id: "cus_01", status: "pending" })
    mockMedusaAdminFetch.mockResolvedValue(expected)

    const result = await checkOrderStatus(INPUT, CTX)

    expect(result).toEqual(expected)
  })

  it("calls correct admin endpoint", async () => {
    await checkOrderStatus(INPUT, CTX)

    expect(mockMedusaAdminFetch).toHaveBeenCalledWith("/admin/orders/order_01")
  })

  it("returns success:false when order belongs to different customer (LGPD)", async () => {
    mockMedusaAdminFetch.mockResolvedValue(
      orderResponse({ customer_id: "cus_OTHER" }),
    )

    const result = await checkOrderStatus(INPUT, CTX) as { success: boolean; message: string }

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido n\u00e3o encontrado.")
  })

  it("returns success:false when Medusa fetch throws", async () => {
    mockMedusaAdminFetch.mockRejectedValue(new Error("Medusa 500"))

    const result = await checkOrderStatus(INPUT, CTX) as { success: boolean; message: string }

    expect(result.success).toBe(false)
    expect(result.message).toContain("Erro ao buscar pedido")
    expect(result.message).toContain("Tente novamente")
  })

  it("allows access when customer_id is in metadata", async () => {
    const expected = {
      order: {
        status: "pending",
        customer_id: undefined,
        metadata: { customerId: "cus_01" },
      },
    }
    mockMedusaAdminFetch.mockResolvedValue(expected)

    const result = await checkOrderStatus(INPUT, CTX)

    expect(result).toEqual(expected)
  })

  it("returns success:false when metadata customerId does not match", async () => {
    mockMedusaAdminFetch.mockResolvedValue({
      order: {
        status: "pending",
        customer_id: undefined,
        metadata: { customerId: "cus_WRONG" },
      },
    })

    const result = await checkOrderStatus(INPUT, CTX) as { success: boolean; message: string }

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido n\u00e3o encontrado.")
  })

  it("allows access when neither customer_id nor metadata customerId set (legacy)", async () => {
    mockMedusaAdminFetch.mockResolvedValue({
      order: { status: "pending" },
    })

    const result = await checkOrderStatus(INPUT, CTX)

    // When orderCustomerId is falsy, the check is skipped
    expect(result).toEqual({ order: { status: "pending" } })
  })

  it("handles different order IDs", async () => {
    const input = { orderId: "order_99" }
    mockMedusaAdminFetch.mockResolvedValue(orderResponse({ id: "order_99", customer_id: "cus_01" }))

    await checkOrderStatus(input, CTX)

    expect(mockMedusaAdminFetch).toHaveBeenCalledWith("/admin/orders/order_99")
  })
})
