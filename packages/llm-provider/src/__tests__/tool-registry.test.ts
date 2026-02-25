// Unit tests for tool-registry.ts — mocked tool implementations

import { describe, it, expect, vi } from "vitest"

// ── Mock all tool implementations ─────────────────────────────────────────────

vi.mock("@ibatexas/tools", () => {
  const makeTool = (name: string) => ({
    name,
    description: `Mock ${name}`,
    inputSchema: { type: "object" as const, properties: {} },
  })

  return {
    searchProducts: vi.fn(async () => ({ products: [] })),
    SearchProductsTool: makeTool("search_products"),
    getProductDetails: vi.fn(async () => ({ product: null })),
    GetProductDetailsTool: makeTool("get_product_details"),
    checkTableAvailability: vi.fn(async () => ({ slots: [] })),
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

import { executeTool, TOOL_DEFINITIONS } from "../tool-registry.js"
import type { AgentContext } from "@ibatexas/types"
import { Channel } from "@ibatexas/types"
import { createReservation, cancelReservation, getMyReservations } from "@ibatexas/tools"

const ctx: AgentContext = {
  channel: Channel.WhatsApp,
  sessionId: "sess_01",
  customerId: "cust_01",
  userType: "customer",
}

// ── TOOL_DEFINITIONS ──────────────────────────────────────────────────────────

describe("TOOL_DEFINITIONS", () => {
  it("has 8 registered tools", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(8)
  })

  it("uses input_schema (snake_case) for Anthropic API", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool).toHaveProperty("input_schema")
      expect(tool).not.toHaveProperty("inputSchema")
    }
  })

  it("contains all expected tool names", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name)
    expect(names).toContain("search_products")
    expect(names).toContain("get_product_details")
    expect(names).toContain("check_table_availability")
    expect(names).toContain("create_reservation")
    expect(names).toContain("modify_reservation")
    expect(names).toContain("cancel_reservation")
    expect(names).toContain("get_my_reservations")
    expect(names).toContain("join_waitlist")
  })
})

// ── executeTool ───────────────────────────────────────────────────────────────

describe("executeTool", () => {
  it("throws for unknown tool name", async () => {
    await expect(executeTool("nonexistent_tool", {}, ctx)).rejects.toThrow(
      "Ferramenta desconhecida: nonexistent_tool",
    )
  })

  it("dispatches search_products with context mapping", async () => {
    await executeTool("search_products", { query: "costela" }, ctx)
    const { searchProducts } = await import("@ibatexas/tools")
    expect(searchProducts).toHaveBeenCalledWith(
      { query: "costela" },
      {
        channel: "whatsapp",
        sessionId: "sess_01",
        userId: "cust_01",
        userType: "customer",
      },
    )
  })

  it("dispatches get_product_details with productId", async () => {
    await executeTool("get_product_details", { productId: "prod_01" }, ctx)
    const { getProductDetails } = await import("@ibatexas/tools")
    expect(getProductDetails).toHaveBeenCalledWith("prod_01")
  })
})

// ── withCustomerId ────────────────────────────────────────────────────────────

describe("withCustomerId injection", () => {
  it("injects customerId from context when absent in input", async () => {
    await executeTool("create_reservation", { timeSlotId: "slot_01", partySize: 4 }, ctx)
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_01" }),
    )
  })

  it("preserves explicit customerId in input", async () => {
    await executeTool(
      "create_reservation",
      { customerId: "other_cust", timeSlotId: "slot_01", partySize: 4 },
      ctx,
    )
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "other_cust" }),
    )
  })

  it("injects customerId for cancel_reservation", async () => {
    await executeTool("cancel_reservation", { reservationId: "res_01" }, ctx)
    expect(cancelReservation).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_01", reservationId: "res_01" }),
    )
  })

  it("injects customerId for get_my_reservations", async () => {
    await executeTool("get_my_reservations", {}, ctx)
    expect(getMyReservations).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_01" }),
    )
  })
})
