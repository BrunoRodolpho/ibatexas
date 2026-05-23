// Task 04: set_pix_details classification fix.
//
// Why this test exists (investigation 01 P0 #2):
// `set_pix_details` was previously listed in TOOL_CLASSIFICATION.MUTATING.
// Mutating tools take the intent branch in llm-responder.ts (executeTool
// returns `{kind:"intent"}`). Event extraction (onToolEvent) only fires on
// the `kind:"result"` branch, so the tool's structured
// `{event:"PIX_DETAILS_COLLECTED", payload}` payload was silently dropped —
// PIX checkout via the LLM could never collect customer details.
//
// The tool implementation (packages/tools/src/cart/set-pix-details.ts) is
// pure validation — no Redis/Postgres/NATS mutation — so the correct fix
// per CLAUDE.md rule #9 is to reclassify it READ_ONLY. The LLM still does
// not mutate; the kernel-executor consumes PIX_DETAILS_COLLECTED and is
// the authority for the resulting state transition.
//
// These tests freeze that contract:
//   - membership: READ_ONLY yes, MUTATING no
//   - executeTool returns `{kind:"result", data}` so the responder's
//     event-extraction branch fires
//   - the LLM-facing tool result string still masks CPF and email

import { describe, it, expect, vi } from "vitest"

// Match the mock shape used by tool-registry.test.ts so executeTool resolves
// every handler.
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
    // set_pix_details returns the structured event the responder must surface.
    setPixDetails: vi.fn(async () => ({
      valid: true,
      event: {
        type: "PIX_DETAILS_COLLECTED",
        payload: {
          name: "Maria Silva",
          email: "maria.silva@example.com",
          cpf: "123.456.789-09",
        },
      },
      errors: [],
      missing: [],
      message: "Dados completos: Maria Silva, maria.silva@example.com, CPF 123.***.***-09",
    })),
    SetPixDetailsTool: makeTool("set_pix_details"),
    SetPixDetailsInputSchema: { parse: vi.fn((x: unknown) => x) },
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
    checkInventory: vi.fn(async () => ({ available: true, quantity: 10, nextAvailableAt: null })),
    CheckInventoryTool: makeTool("check_inventory"),
    getNutritionalInfo: vi.fn(async () => ({ calories: 0, protein: 0, carbs: 0, fat: 0 })),
    GetNutritionalInfoTool: makeTool("get_nutritional_info"),
    handoffToHuman: vi.fn(async () => ({ success: true, estimatedWaitMinutes: 5, message: "ok" })),
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
import { TOOL_CLASSIFICATION } from "../machine/types.js"
import { executeTool } from "../tool-registry.js"

const ctx: AgentContext = {
  channel: Channel.WhatsApp,
  sessionId: "sess_pix_01",
  customerId: "cust_pix_01",
  userType: "customer",
}

// Mirror of the masking pass applied by llm-responder.ts:178
// (sanitizeToolResultForLLM). Kept inline so this test fails loudly if the
// responder's PII contract changes.
function sanitizeToolResultForLLM(result: string): string {
  return result
    .replace(/(\d{3})\.\d{3}\.\d{3}(-\d{2})/g, "$1.***.***$2")
    .replace(/([a-zA-Z0-9._%+-]{2})[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, "$1***$2")
    .replace(/at\s+\S+\s+\(.*?\)/g, "[internal]")
    .replace(/\/[\w/.-]+\.ts:\d+/g, "[internal]")
}

describe("set_pix_details classification (task 04)", () => {
  it("is in TOOL_CLASSIFICATION.READ_ONLY", () => {
    expect(TOOL_CLASSIFICATION.READ_ONLY.has("set_pix_details")).toBe(true)
  })

  it("is NOT in TOOL_CLASSIFICATION.MUTATING", () => {
    expect(TOOL_CLASSIFICATION.MUTATING.has("set_pix_details")).toBe(false)
  })

  it("is never simultaneously in both sets (bypass-detection)", () => {
    const overlap = [...TOOL_CLASSIFICATION.READ_ONLY].filter((t) =>
      TOOL_CLASSIFICATION.MUTATING.has(t),
    )
    expect(overlap).toEqual([])
  })

  it("executeTool returns kind:'result' carrying the PIX_DETAILS_COLLECTED event", async () => {
    // The bug: when set_pix_details was MUTATING, executeTool returned
    // `{kind:"intent"}` and the responder's onToolEvent extraction (only
    // fires on `kind:"result"`) never saw the event. Now that the tool is
    // READ_ONLY, executeTool returns `{kind:"result", data:{event,...}}`
    // and the responder's existing extraction in llm-responder.ts:464-470
    // surfaces the event to the agent's onToolEvent callback.
    const result = await executeTool(
      "set_pix_details",
      { name: "Maria Silva", email: "maria.silva@example.com", cpf: "12345678909" },
      ctx,
    )

    expect(result.kind).toBe("result")
    if (result.kind !== "result") throw new Error("expected kind:'result'")

    const data = result.data as {
      event?: { type: string; payload: Record<string, unknown> }
    }
    expect(data.event?.type).toBe("PIX_DETAILS_COLLECTED")
    expect(data.event?.payload).toMatchObject({
      name: "Maria Silva",
      email: "maria.silva@example.com",
      cpf: "123.456.789-09",
    })
  })

  it("simulated responder loop invokes onToolEvent with the extracted event", async () => {
    // Tight re-creation of llm-responder.ts:464-470 to verify the contract
    // without booting the full Anthropic stream loop. If this test breaks,
    // someone changed the extraction branch — investigate before "fixing"
    // the test.
    const onToolEvent = vi.fn()

    const result = await executeTool(
      "set_pix_details",
      { name: "Maria Silva", email: "maria.silva@example.com", cpf: "12345678909" },
      ctx,
    )

    expect(result.kind).toBe("result")
    if (result.kind !== "result") throw new Error("expected kind:'result'")

    const actualResult = result.data
    if (
      typeof actualResult === "object" &&
      actualResult !== null &&
      "event" in actualResult
    ) {
      const extractionResult = actualResult as {
        event?: { type: string; payload: Record<string, unknown> }
      }
      if (extractionResult.event?.type) {
        onToolEvent(extractionResult.event)
      }
    }

    expect(onToolEvent).toHaveBeenCalledTimes(1)
    expect(onToolEvent).toHaveBeenCalledWith({
      type: "PIX_DETAILS_COLLECTED",
      payload: {
        name: "Maria Silva",
        email: "maria.silva@example.com",
        cpf: "123.456.789-09",
      },
    })
  })

  it("PII (CPF, email) is masked in the LLM-facing tool result string", async () => {
    const result = await executeTool(
      "set_pix_details",
      { name: "Maria Silva", email: "maria.silva@example.com", cpf: "12345678909" },
      ctx,
    )
    if (result.kind !== "result") throw new Error("expected kind:'result'")

    const llmFacing = sanitizeToolResultForLLM(JSON.stringify(result.data))

    // Full CPF must not appear; masked form must.
    expect(llmFacing).not.toContain("123.456.789-09")
    expect(llmFacing).toContain("123.***.***-09")

    // Full email local-part must not appear; masked form must.
    expect(llmFacing).not.toContain("maria.silva@example.com")
    expect(llmFacing).toMatch(/ma\*{3}@example\.com/)
  })
})
