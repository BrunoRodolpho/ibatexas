// Edge-case tests for tool-registry — covers gaps from deep review:
// - Guest context without customerId (now throws)
// - withCustomerId for modify_reservation and join_waitlist
// - check_table_availability dispatch

import { describe, it, expect, vi } from "vitest"

vi.mock("@ibatexas/tools", () => {
  const makeTool = (name: string) => ({
    name,
    description: `Mock ${name}`,
    inputSchema: { type: "object" as const, properties: {} },
  })

  return {
    searchProducts: vi.fn(async () => ({ products: [] })),
    SearchProductsTool: makeTool("search_products"),
    getProductDetails: vi.fn(async () => null),
    GetProductDetailsTool: makeTool("get_product_details"),
    checkTableAvailability: vi.fn(async () => ({ slots: [], message: "Nenhuma mesa" })),
    CheckTableAvailabilityTool: makeTool("check_table_availability"),
    createReservation: vi.fn(async () => ({ reservationId: "res_01" })),
    CreateReservationTool: makeTool("create_reservation"),
    modifyReservation: vi.fn(async () => ({ success: true })),
    ModifyReservationTool: makeTool("modify_reservation"),
    cancelReservation: vi.fn(async () => ({ success: true })),
    CancelReservationTool: makeTool("cancel_reservation"),
    getMyReservations: vi.fn(async () => ({ reservations: [] })),
    GetMyReservationsTool: makeTool("get_my_reservations"),
    joinWaitlist: vi.fn(async () => ({ waitlistId: "wl_01" })),
    JoinWaitlistTool: makeTool("join_waitlist"),
  }
})

import { executeTool } from "../tool-registry.js"
import type { AgentContext } from "@ibatexas/types"
import { Channel } from "@ibatexas/types"
import { modifyReservation, joinWaitlist, checkTableAvailability } from "@ibatexas/tools"

const guestCtx: AgentContext = {
  channel: Channel.Web,
  sessionId: "guest-session",
  userType: "guest",
  // no customerId
}

const customerCtx: AgentContext = {
  channel: Channel.WhatsApp,
  sessionId: "cust-session",
  customerId: "cust_02",
  userType: "customer",
}

describe("tool-registry edge cases", () => {
  it("guest without customerId throws on create_reservation", async () => {
    await expect(
      executeTool("create_reservation", { timeSlotId: "s1", partySize: 2 }, guestCtx),
    ).rejects.toThrow("Autenticação necessária")
  })

  it("guest without customerId throws on cancel_reservation", async () => {
    await expect(
      executeTool("cancel_reservation", { reservationId: "r1" }, guestCtx),
    ).rejects.toThrow("Autenticação necessária")
  })

  it("guest without customerId throws on get_my_reservations", async () => {
    await expect(
      executeTool("get_my_reservations", {}, guestCtx),
    ).rejects.toThrow("Autenticação necessária")
  })

  it("guest without customerId throws on modify_reservation", async () => {
    await expect(
      executeTool("modify_reservation", { reservationId: "r1" }, guestCtx),
    ).rejects.toThrow("Autenticação necessária")
  })

  it("guest without customerId throws on join_waitlist", async () => {
    await expect(
      executeTool("join_waitlist", { timeSlotId: "s1", partySize: 2 }, guestCtx),
    ).rejects.toThrow("Autenticação necessária")
  })

  it("injects customerId for modify_reservation", async () => {
    await executeTool(
      "modify_reservation",
      { reservationId: "r1", newPartySize: 5 },
      customerCtx,
    )
    expect(modifyReservation).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_02", reservationId: "r1", newPartySize: 5 }),
    )
  })

  it("injects customerId for join_waitlist", async () => {
    await executeTool(
      "join_waitlist",
      { timeSlotId: "s1", partySize: 3 },
      customerCtx,
    )
    expect(joinWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_02", timeSlotId: "s1", partySize: 3 }),
    )
  })

  it("dispatches check_table_availability without customerId", async () => {
    await executeTool(
      "check_table_availability",
      { date: "2026-03-01", partySize: 4 },
      guestCtx,
    )
    expect(checkTableAvailability).toHaveBeenCalledWith({ date: "2026-03-01", partySize: 4 })
  })
})
