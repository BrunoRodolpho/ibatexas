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
    estimateDelivery: vi.fn(async () => ({ deliverable: true, fee: 500 })),
    EstimateDeliveryTool: makeTool("estimate_delivery"),
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
    // Cart tools
    getCart: vi.fn(async () => ({ cart: null })),
    GetCartTool: makeTool("get_cart"),
    addToCart: vi.fn(async () => ({ success: true })),
    AddToCartTool: makeTool("add_to_cart"),
    updateCart: vi.fn(async () => ({ success: true })),
    UpdateCartTool: makeTool("update_cart"),
    removeFromCart: vi.fn(async () => ({ success: true })),
    RemoveFromCartTool: makeTool("remove_from_cart"),
    applyCoupon: vi.fn(async () => ({ valid: true })),
    ApplyCouponTool: makeTool("apply_coupon"),
    createCheckout: vi.fn(async () => ({ success: true })),
    CreateCheckoutTool: makeTool("create_checkout"),
    getOrderHistory: vi.fn(async () => ({ orders: [] })),
    GetOrderHistoryTool: makeTool("get_order_history"),
    checkOrderStatus: vi.fn(async () => ({ status: "pending" })),
    CheckOrderStatusTool: makeTool("check_order_status"),
    cancelOrder: vi.fn(async () => ({ success: true })),
    CancelOrderTool: makeTool("cancel_order"),
    reorder: vi.fn(async () => ({ cartId: "cart_01" })),
    ReorderTool: makeTool("reorder"),
    // Intelligence tools
    getCustomerProfile: vi.fn(async () => ({})),
    GetCustomerProfileTool: makeTool("get_customer_profile"),
    getRecommendations: vi.fn(async () => ({ products: [] })),
    GetRecommendationsTool: makeTool("get_recommendations"),
    updatePreferences: vi.fn(async () => ({ success: true })),
    UpdatePreferencesTool: makeTool("update_preferences"),
    submitReview: vi.fn(async () => ({ success: true })),
    SubmitReviewTool: makeTool("submit_review"),
    getAlsoAdded: vi.fn(async () => ({ products: [] })),
    GetAlsoAddedTool: makeTool("get_also_added"),
    getOrderedTogether: vi.fn(async () => ({ products: [] })),
    GetOrderedTogetherTool: makeTool("get_ordered_together"),
    PROFILE_TTL_SECONDS: 2_592_000,
    RECENTLY_VIEWED_MAX: 20,
  }
})

import { executeTool, TOOL_DEFINITIONS } from "../tool-registry.js"
import { Channel, type AgentContext } from "@ibatexas/types"
import { createReservation, cancelReservation, getMyReservations } from "@ibatexas/tools"

const ctx: AgentContext = {
  channel: Channel.WhatsApp,
  sessionId: "sess_01",
  customerId: "cust_01",
  userType: "customer",
}

// ── TOOL_DEFINITIONS ──────────────────────────────────────────────────────────

describe("TOOL_DEFINITIONS", () => {
  it("has 25 registered tools", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(25)
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
    expect(getProductDetails).toHaveBeenCalledWith("prod_01", "cust_01")
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

  // AUDIT-FIX: TST-C02 — LLM-supplied customerId must ALWAYS be overridden by ctx.customerId
  it("overrides LLM-supplied customerId with session context", async () => {
    await executeTool(
      "create_reservation",
      { customerId: "other_cust", timeSlotId: "slot_01", partySize: 4 },
      ctx,
    )
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_01" }),
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

  // AUDIT-FIX: Phase 3 — withCustomerId ALWAYS uses ctx.customerId, even when LLM supplies a different one
  it("always uses ctx.customerId regardless of LLM-supplied customerId for all reservation tools", async () => {
    const reservationTools = [
      { name: "create_reservation", input: { customerId: "attacker_id", timeSlotId: "slot_01", partySize: 2 }, mock: createReservation },
      { name: "cancel_reservation", input: { customerId: "attacker_id", reservationId: "res_99" }, mock: cancelReservation },
      { name: "get_my_reservations", input: { customerId: "attacker_id" }, mock: getMyReservations },
    ]

    for (const { name, input, mock } of reservationTools) {
      vi.clearAllMocks()
      await executeTool(name, input, ctx)
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cust_01" }),
      )
      expect(mock).not.toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "attacker_id" }),
      )
    }
  })

  // AUDIT-FIX: Phase 3 — withCustomerId throws when ctx.customerId is missing (guest)
  it("throws when ctx.customerId is missing for auth-required tools", async () => {
    const guestCtx: AgentContext = { ...ctx, customerId: undefined }
    await expect(
      executeTool("create_reservation", { timeSlotId: "slot_01", partySize: 2 }, guestCtx),
    ).rejects.toThrow("Autenticação necessária")
  })
})

// ── Zod validation ──────────────────────────────────────────────────────────

describe("Zod input validation", () => {
  // AUDIT-FIX: Phase 3 — Zod validation rejects malformed tool input (missing required fields)
  it("rejects get_product_details with missing productId", async () => {
    await expect(executeTool("get_product_details", {}, ctx)).rejects.toThrow()
  })

  it("rejects estimate_delivery with missing cep", async () => {
    await expect(executeTool("estimate_delivery", {}, ctx)).rejects.toThrow()
  })

  it("rejects create_reservation with missing required fields", async () => {
    await expect(executeTool("create_reservation", {}, ctx)).rejects.toThrow()
  })

  it("accepts valid get_product_details input", async () => {
    await expect(executeTool("get_product_details", { productId: "prod_01" }, ctx)).resolves.not.toThrow()
  })

  it("accepts valid estimate_delivery input", async () => {
    await expect(executeTool("estimate_delivery", { cep: "01001000" }, ctx)).resolves.not.toThrow()
  })
})
