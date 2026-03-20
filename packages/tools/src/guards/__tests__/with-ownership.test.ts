// Tests for composable ownership guard wrappers (SEC-002)
// Mock-based; no database or network required.
//
// Scenarios per wrapper:
// - Delegates to assertOrderOwnership / assertReservationOwnership before calling handler
// - Handler is NOT called when guard throws
// - Handler IS called (with original args) when guard passes
// - Guard receives the correct resource ID and customer ID

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockAssertOrderOwnership = vi.hoisted(() => vi.fn())
const mockAssertReservationOwnership = vi.hoisted(() => vi.fn())

vi.mock("../ownership.js", () => ({
  assertOrderOwnership: mockAssertOrderOwnership,
  assertReservationOwnership: mockAssertReservationOwnership,
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { withOrderOwnership, withReservationOwnership } from "../with-ownership.js"
import type { AgentContext } from "@ibatexas/types"

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CTX: AgentContext = {
  channel: "whatsapp" as AgentContext["channel"],
  sessionId: "sess_test",
  customerId: "cus_01",
  userType: "customer" as AgentContext["userType"],
}

// ── withOrderOwnership ─────────────────────────────────────────────────────────

describe("withOrderOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls assertOrderOwnership with orderId and customerId before handler", async () => {
    const callOrder: string[] = []
    mockAssertOrderOwnership.mockImplementation(async () => { callOrder.push("guard") })
    const handler = vi.fn().mockImplementation(async () => { callOrder.push("handler"); return { order: "data" } })
    const wrapped = withOrderOwnership(handler)

    await wrapped({ orderId: "order_01" }, CTX)

    expect(mockAssertOrderOwnership).toHaveBeenCalledWith("order_01", "cus_01")
    expect(handler).toHaveBeenCalledWith({ orderId: "order_01" }, CTX)
    expect(callOrder).toEqual(["guard", "handler"])
  })

  it("returns the handler result when guard passes", async () => {
    mockAssertOrderOwnership.mockResolvedValue(undefined)
    const handler = vi.fn().mockResolvedValue({ order: { status: "pending" } })
    const wrapped = withOrderOwnership(handler)

    const result = await wrapped({ orderId: "order_01" }, CTX)

    expect(result).toEqual({ order: { status: "pending" } })
  })

  it("does NOT call handler when guard throws", async () => {
    mockAssertOrderOwnership.mockRejectedValue(new Error("Acesso negado"))
    const handler = vi.fn().mockResolvedValue({ order: "data" })
    const wrapped = withOrderOwnership(handler)

    await expect(wrapped({ orderId: "order_01" }, CTX)).rejects.toThrow("Acesso negado")
    expect(handler).not.toHaveBeenCalled()
  })

  it("propagates guard error type unchanged", async () => {
    const guardError = new Error("Pedido não encontrado.")
    guardError.name = "NonRetryableError"
    mockAssertOrderOwnership.mockRejectedValue(guardError)
    const handler = vi.fn()
    const wrapped = withOrderOwnership(handler)

    await expect(wrapped({ orderId: "order_99" }, CTX)).rejects.toThrow("Pedido não encontrado.")
  })

  it("passes additional input fields through to handler", async () => {
    mockAssertOrderOwnership.mockResolvedValue(undefined)
    const handler = vi.fn().mockResolvedValue("ok")
    const wrapped = withOrderOwnership<{ orderId: string; extra: number }, string>(handler)

    await wrapped({ orderId: "order_01", extra: 42 }, CTX)

    expect(handler).toHaveBeenCalledWith({ orderId: "order_01", extra: 42 }, CTX)
  })

  it("skips guard and delegates to handler when customerId is missing", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("Autenticação necessária"))
    const wrapped = withOrderOwnership(handler)

    const guestCtx: AgentContext = { ...CTX, customerId: undefined }

    await expect(wrapped({ orderId: "order_01" }, guestCtx)).rejects.toThrow("Autenticação necessária")
    // Guard should NOT be called when there's no customer to verify against
    expect(mockAssertOrderOwnership).not.toHaveBeenCalled()
    // Handler IS called — it's responsible for its own auth error
    expect(handler).toHaveBeenCalledWith({ orderId: "order_01" }, guestCtx)
  })
})

// ── withReservationOwnership ───────────────────────────────────────────────────

describe("withReservationOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls assertReservationOwnership with reservationId and customerId before handler", async () => {
    const callOrder: string[] = []
    mockAssertReservationOwnership.mockImplementation(async () => { callOrder.push("guard") })
    const handler = vi.fn().mockImplementation(async () => { callOrder.push("handler"); return { success: true } })
    const wrapped = withReservationOwnership(handler)

    await wrapped({ reservationId: "res_01", customerId: "cus_01" })

    expect(mockAssertReservationOwnership).toHaveBeenCalledWith("res_01", "cus_01")
    expect(handler).toHaveBeenCalledWith({ reservationId: "res_01", customerId: "cus_01" })
    expect(callOrder).toEqual(["guard", "handler"])
  })

  it("returns the handler result when guard passes", async () => {
    mockAssertReservationOwnership.mockResolvedValue(undefined)
    const handler = vi.fn().mockResolvedValue({ success: true, message: "ok" })
    const wrapped = withReservationOwnership(handler)

    const result = await wrapped({ reservationId: "res_01", customerId: "cus_01" })

    expect(result).toEqual({ success: true, message: "ok" })
  })

  it("does NOT call handler when guard throws", async () => {
    mockAssertReservationOwnership.mockRejectedValue(new Error("Acesso negado"))
    const handler = vi.fn().mockResolvedValue({ success: true })
    const wrapped = withReservationOwnership(handler)

    await expect(
      wrapped({ reservationId: "res_01", customerId: "cus_wrong" }),
    ).rejects.toThrow("Acesso negado")
    expect(handler).not.toHaveBeenCalled()
  })

  it("propagates guard error type unchanged", async () => {
    const guardError = new Error("Reserva não encontrada.")
    guardError.name = "NonRetryableError"
    mockAssertReservationOwnership.mockRejectedValue(guardError)
    const handler = vi.fn()
    const wrapped = withReservationOwnership(handler)

    await expect(
      wrapped({ reservationId: "res_99", customerId: "cus_01" }),
    ).rejects.toThrow("Reserva não encontrada.")
  })

  it("passes additional input fields through to handler", async () => {
    mockAssertReservationOwnership.mockResolvedValue(undefined)
    const handler = vi.fn().mockResolvedValue("ok")
    const wrapped = withReservationOwnership<
      { reservationId: string; customerId: string; reason?: string },
      string
    >(handler)

    await wrapped({ reservationId: "res_01", customerId: "cus_01", reason: "changed plans" })

    expect(handler).toHaveBeenCalledWith({
      reservationId: "res_01",
      customerId: "cus_01",
      reason: "changed plans",
    })
  })
})
