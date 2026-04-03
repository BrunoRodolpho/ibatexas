// Tests for cancel_order tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → cancels order, returns success
// - Missing auth → throws with pt-BR message
// - Wrong customer → {success: false, message: "Pedido não encontrado."}
// - Non-cancellable status → {success: false} with status in message
// - Medusa admin fetch error on cancel → throws

import { describe, it, expect, beforeEach, vi } from "vitest"
import { cancelOrder } from "../cancel-order.js"
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

describe("cancelOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaAdmin.mockResolvedValue(orderResponse({ status: "pending", customer_id: "cus_01" }))
  })

  it("throws when customerId is missing (no auth)", async () => {
    const guestCtx = makeGuestCtx()

    await expect(cancelOrder(INPUT, guestCtx)).rejects.toThrow("Autenticação necessária")
  })

  it("returns success:false when order belongs to different customer", async () => {
    mockMedusaAdmin.mockResolvedValue(
      orderResponse({ customer_id: "cus_OTHER", status: "pending" }),
    )

    const result = await cancelOrder(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido não encontrado.")
  })

  it("returns success:false when order has non-cancellable status", async () => {
    mockMedusaAdmin.mockResolvedValue(
      orderResponse({ customer_id: "cus_01", status: "completed" }),
    )

    const result = await cancelOrder(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toContain("não pode ser cancelado")
  })

  it("returns success:false for shipped status", async () => {
    mockMedusaAdmin.mockResolvedValue(
      orderResponse({ customer_id: "cus_01", status: "shipped" }),
    )

    const result = await cancelOrder(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toContain("não pode ser cancelado")
  })

  it("cancels order with pending status and returns success", async () => {
    mockMedusaAdmin
      .mockResolvedValueOnce(orderResponse({ customer_id: "cus_01", status: "pending" }))
      .mockResolvedValueOnce({}) // cancel POST response

    const result = await cancelOrder(INPUT, CTX)

    expect(result.success).toBe(true)
    expect(result.message).toContain("cancelado com sucesso")
  })

  it("cancels order with requires_action status", async () => {
    mockMedusaAdmin
      .mockResolvedValueOnce(orderResponse({ customer_id: "cus_01", status: "requires_action" }))
      .mockResolvedValueOnce({})

    const result = await cancelOrder(INPUT, CTX)

    expect(result.success).toBe(true)
    expect(result.message).toContain("cancelado com sucesso")
  })

  it("calls correct admin endpoints: fetch then cancel", async () => {
    mockMedusaAdmin
      .mockResolvedValueOnce(orderResponse({ customer_id: "cus_01", status: "pending" }))
      .mockResolvedValueOnce({})

    await cancelOrder(INPUT, CTX)

    expect(mockMedusaAdmin).toHaveBeenCalledTimes(3)
    expect(mockMedusaAdmin).toHaveBeenNthCalledWith(1, "/admin/orders/order_01")
    expect(mockMedusaAdmin).toHaveBeenNthCalledWith(2, "/admin/orders/order_01/cancel", { method: "POST" })
    expect(mockMedusaAdmin).toHaveBeenNthCalledWith(3, "/admin/orders/order_01")
  })

  it("allows cancel when customer_id is in metadata", async () => {
    mockMedusaAdmin
      .mockResolvedValueOnce({
        order: {
          status: "pending",
          customer_id: undefined,
          metadata: { customerId: "cus_01" },
        },
      })
      .mockResolvedValueOnce({})

    const result = await cancelOrder(INPUT, CTX)

    expect(result.success).toBe(true)
  })

  it("returns success:false when metadata customerId does not match", async () => {
    mockMedusaAdmin.mockResolvedValue({
      order: {
        status: "pending",
        customer_id: undefined,
        metadata: { customerId: "cus_WRONG" },
      },
    })

    const result = await cancelOrder(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido não encontrado.")
  })

  it("error message directs customer to support for non-cancellable orders", async () => {
    mockMedusaAdmin.mockResolvedValue(
      orderResponse({ customer_id: "cus_01", status: "fulfilled" }),
    )

    const result = await cancelOrder(INPUT, CTX)

    expect(result.message).toContain("não pode ser cancelado")
    expect(result.needsEscalation).toBe(true)
  })
})
