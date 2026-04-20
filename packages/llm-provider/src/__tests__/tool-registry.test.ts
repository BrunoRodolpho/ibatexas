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
    getOrCreateCart: vi.fn(async () => ({ cartId: "cart_01", items: [], totalInCentavos: 0 })),
    GetOrCreateCartTool: makeTool("get_or_create_cart"),
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
    checkPaymentStatus: vi.fn(async () => ({ status: "pending" })),
    CheckPaymentStatusTool: makeTool("check_payment_status"),
    cancelOrder: vi.fn(async () => ({ success: true })),
    CancelOrderTool: makeTool("cancel_order"),
    amendOrder: vi.fn(async () => ({ success: true })),
    AmendOrderTool: makeTool("amend_order"),
    reorder: vi.fn(async () => ({ cartId: "cart_01" })),
    ReorderTool: makeTool("reorder"),
    regeneratePix: vi.fn(async () => ({ success: true, pixCopyPaste: "00020126" })),
    RegeneratePixTool: makeTool("regenerate_pix"),
    setPixDetails: vi.fn(async () => ({ valid: true, event: { type: "PIX_DETAILS_COLLECTED", payload: {} }, errors: [], missing: [], message: "" })),
    SetPixDetailsTool: makeTool("set_pix_details"),
    SetPixDetailsInputSchema: { parse: vi.fn((x: unknown) => x) },
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
    // Catalog tools
    checkInventory: vi.fn(async () => ({ available: true, quantity: 10, nextAvailableAt: null })),
    CheckInventoryTool: makeTool("check_inventory"),
    getNutritionalInfo: vi.fn(async () => ({ calories: 0, protein: 0, carbs: 0, fat: 0 })),
    GetNutritionalInfoTool: makeTool("get_nutritional_info"),
    // Support tools
    handoffToHuman: vi.fn(async () => ({ success: true, estimatedWaitMinutes: 5, message: "Um atendente foi notificado e entrará em contato em breve." })),
    HandoffToHumanTool: makeTool("handoff_to_human"),
    // Follow-up tool
    scheduleFollowUp: vi.fn(async () => ({ success: true, message: "Lembrete agendado." })),
    ScheduleFollowUpTool: makeTool("schedule_follow_up"),
    // Loyalty tool
    getLoyaltyBalance: vi.fn(async () => ({ stamps: 3, stampsNeeded: 7, totalEarned: 3, message: "3 de 10 selos" })),
    GetLoyaltyBalanceTool: makeTool("get_loyalty_balance"),
    PROFILE_TTL_SECONDS: 2_592_000,
    RECENTLY_VIEWED_MAX: 20,
  }
})

import { Channel, type AgentContext } from "@ibatexas/types"
import { createReservation, cancelReservation, getMyReservations } from "@ibatexas/tools"
import { executeTool, executeToolDirect, TOOL_DEFINITIONS } from "../tool-registry.js"

const ctx: AgentContext = {
  channel: Channel.WhatsApp,
  sessionId: "sess_01",
  customerId: "cust_01",
  userType: "customer",
}

// ── TOOL_DEFINITIONS ──────────────────────────────────────────────────────────

describe("TOOL_DEFINITIONS", () => {
  it("has 35 registered tools", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(35)
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
  // MUTATING tools return intents via executeTool (Zero-Trust LLM).
  // Use executeToolDirect to test withCustomerId — the kernel execution path.

  it("injects customerId from context when absent in input", async () => {
    await executeToolDirect("create_reservation", { timeSlotId: "slot_01", partySize: 4 }, ctx)
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_01" }),
    )
  })

  it("overrides LLM-supplied customerId with session context", async () => {
    await executeToolDirect(
      "create_reservation",
      { customerId: "other_cust", timeSlotId: "slot_01", partySize: 4 },
      ctx,
    )
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_01" }),
    )
  })

  it("injects customerId for cancel_reservation", async () => {
    await executeToolDirect("cancel_reservation", { reservationId: "res_01" }, ctx)
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

  it("always uses ctx.customerId regardless of LLM-supplied customerId for all reservation tools", async () => {
    const reservationTools = [
      { name: "create_reservation", input: { customerId: "attacker_id", timeSlotId: "slot_01", partySize: 2 }, mock: createReservation },
      { name: "cancel_reservation", input: { customerId: "attacker_id", reservationId: "res_99" }, mock: cancelReservation },
      { name: "get_my_reservations", input: { customerId: "attacker_id" }, mock: getMyReservations },
    ]

    for (const { name, input, mock } of reservationTools) {
      vi.clearAllMocks()
      await executeToolDirect(name, input, ctx)
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cust_01" }),
      )
      expect(mock).not.toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "attacker_id" }),
      )
    }
  })

  it("returns intent for MUTATING tools via executeTool", async () => {
    const result = await executeTool("create_reservation", { timeSlotId: "slot_01", partySize: 2 }, ctx)
    expect(result).toEqual({
      kind: "intent",
      intent: { toolName: "create_reservation", input: { timeSlotId: "slot_01", partySize: 2 }, toolUseId: "" },
    })
  })

  it("throws when ctx.customerId is missing for auth-required tools", async () => {
    const guestCtx: AgentContext = { ...ctx, customerId: undefined }
    await expect(
      executeToolDirect("create_reservation", { timeSlotId: "slot_01", partySize: 2 }, guestCtx),
    ).rejects.toThrow("Autenticação necessária")
  })
})

// ── Zod validation ──────────────────────────────────────────────────────────

describe("Zod input validation", () => {
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
