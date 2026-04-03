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
    estimateDelivery: vi.fn(async () => ({ deliverable: true, fee: 500 })),
    EstimateDeliveryTool: makeTool("estimate_delivery"),
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
    scheduleFollowUp: vi.fn(async () => ({ success: true, message: "Lembrete agendado." })),
    ScheduleFollowUpTool: makeTool("schedule_follow_up"),
    getLoyaltyBalance: vi.fn(async () => ({ stamps: 3, stampsNeeded: 7, totalEarned: 3, message: "3 de 10 selos" })),
    GetLoyaltyBalanceTool: makeTool("get_loyalty_balance"),
    PROFILE_TTL_SECONDS: 2_592_000,
    RECENTLY_VIEWED_MAX: 20,
  }
})

import { Channel, type AgentContext } from "@ibatexas/types"
import { modifyReservation, joinWaitlist, checkTableAvailability } from "@ibatexas/tools"
import { executeTool } from "../tool-registry.js"

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
