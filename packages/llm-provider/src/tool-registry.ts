// Tool registry — maps Claude tool names to their execute handlers.
// Add new tools here as they are implemented in packages/tools.

import {
  searchProducts,
  SearchProductsTool,
  getProductDetails,
  GetProductDetailsTool,
  estimateDelivery,
  EstimateDeliveryTool,
  checkTableAvailability,
  CheckTableAvailabilityTool,
  createReservation,
  CreateReservationTool,
  modifyReservation,
  ModifyReservationTool,
  cancelReservation,
  CancelReservationTool,
  getMyReservations,
  GetMyReservationsTool,
  joinWaitlist,
  JoinWaitlistTool,
  // Cart tools
  getCart,
  GetCartTool,
  addToCart,
  AddToCartTool,
  updateCart,
  UpdateCartTool,
  removeFromCart,
  RemoveFromCartTool,
  applyCoupon,
  ApplyCouponTool,
  createCheckout,
  CreateCheckoutTool,
  getOrderHistory,
  GetOrderHistoryTool,
  checkOrderStatus,
  CheckOrderStatusTool,
  cancelOrder,
  CancelOrderTool,
  reorder,
  ReorderTool,
  // Intelligence tools
  getCustomerProfile,
  GetCustomerProfileTool,
  getRecommendations,
  GetRecommendationsTool,
  updatePreferences,
  UpdatePreferencesTool,
  submitReview,
  SubmitReviewTool,
  getAlsoAdded,
  GetAlsoAddedTool,
  getOrderedTogether,
  GetOrderedTogetherTool,
} from "@ibatexas/tools"
import type { AgentContext } from "@ibatexas/types"
import type { Tool } from "@anthropic-ai/sdk/resources/index.js"

// ── Tool definitions (passed to Claude API) ───────────────────────────────────
// SearchProductsTool uses `inputSchema` (camelCase) for internal use.
// The Anthropic SDK requires `input_schema` (snake_case) — adapt here.

function toAnthropicTool(tool: { name: string; description: string; inputSchema: object }): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Tool["input_schema"],
  }
}

export const TOOL_DEFINITIONS: Tool[] = [
  toAnthropicTool(SearchProductsTool),
  toAnthropicTool(GetProductDetailsTool),
  toAnthropicTool(EstimateDeliveryTool),
  // Reservation tools
  toAnthropicTool(CheckTableAvailabilityTool),
  toAnthropicTool(CreateReservationTool),
  toAnthropicTool(ModifyReservationTool),
  toAnthropicTool(CancelReservationTool),
  toAnthropicTool(GetMyReservationsTool),
  toAnthropicTool(JoinWaitlistTool),
  // Cart tools
  toAnthropicTool(GetCartTool),
  toAnthropicTool(AddToCartTool),
  toAnthropicTool(UpdateCartTool),
  toAnthropicTool(RemoveFromCartTool),
  toAnthropicTool(ApplyCouponTool),
  toAnthropicTool(CreateCheckoutTool),
  toAnthropicTool(GetOrderHistoryTool),
  toAnthropicTool(CheckOrderStatusTool),
  toAnthropicTool(CancelOrderTool),
  toAnthropicTool(ReorderTool),
  // Intelligence tools
  toAnthropicTool(GetCustomerProfileTool),
  toAnthropicTool(GetRecommendationsTool),
  toAnthropicTool(UpdatePreferencesTool),
  toAnthropicTool(SubmitReviewTool),
  toAnthropicTool(GetAlsoAddedTool),
  toAnthropicTool(GetOrderedTogetherTool),
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

type ToolHandler = (input: unknown, ctx: AgentContext) => Promise<unknown>

/**
 * Higher-order function: injects customerId from AgentContext when absent in input.
 * Throws early when authentication is required but customerId is missing.
 */
function withCustomerId<T extends { customerId?: string }>(
  fn: (input: T) => Promise<unknown>,
): ToolHandler {
  return (input, ctx) => {
    const i = input as T
    if (!i.customerId && ctx.customerId) {
      return fn({ ...i, customerId: ctx.customerId })
    }
    if (!i.customerId && !ctx.customerId) {
      throw new Error("Autenticação necessária. O cliente precisa se identificar para usar esta funcionalidade.")
    }
    return fn(i)
  }
}

const handlers = new Map<string, ToolHandler>([
  [
    "search_products",
    (input, ctx) =>
      searchProducts(input as Parameters<typeof searchProducts>[0], {
        channel: ctx.channel,
        sessionId: ctx.sessionId,
        userId: ctx.customerId,
        userType: ctx.userType,
      }),
  ],
  [
    "get_product_details",
    (input, ctx) => {
      const { productId } = input as { productId: string }
      return getProductDetails(productId, ctx.customerId)
    },
  ],
  [
    "estimate_delivery",
    (input) => estimateDelivery(input as Parameters<typeof estimateDelivery>[0]),
  ],
  // ── Reservation tools ──────────────────────────────────────────────────────
  [
    "check_table_availability",
    (input) => checkTableAvailability(input as Parameters<typeof checkTableAvailability>[0]),
  ],
  ["create_reservation", withCustomerId(createReservation)],
  ["modify_reservation", withCustomerId(modifyReservation)],
  ["cancel_reservation", withCustomerId(cancelReservation)],
  ["get_my_reservations", withCustomerId(getMyReservations)],
  ["join_waitlist", withCustomerId(joinWaitlist)],
  // ── Cart tools (guest: get_cart, add_to_cart, update_cart, remove_from_cart, apply_coupon)
  // ── Cart tools (customer: create_checkout, get_order_history, check_order_status, cancel_order, reorder)
  // All cart tools use (input, ctx) signature — ctx passed through for auth + event tracking
  ["get_cart", (input, ctx) => getCart(input as Parameters<typeof getCart>[0], ctx)],
  ["add_to_cart", (input, ctx) => addToCart(input as Parameters<typeof addToCart>[0], ctx)],
  ["update_cart", (input, ctx) => updateCart(input as Parameters<typeof updateCart>[0], ctx)],
  ["remove_from_cart", (input, ctx) => removeFromCart(input as Parameters<typeof removeFromCart>[0], ctx)],
  ["apply_coupon", (input, ctx) => applyCoupon(input as Parameters<typeof applyCoupon>[0], ctx)],
  ["create_checkout", (input, ctx) => createCheckout(input as Parameters<typeof createCheckout>[0], ctx)],
  ["get_order_history", (input, ctx) => getOrderHistory(input as Parameters<typeof getOrderHistory>[0], ctx)],
  ["check_order_status", (input, ctx) => checkOrderStatus(input as Parameters<typeof checkOrderStatus>[0], ctx)],
  ["cancel_order", (input, ctx) => cancelOrder(input as Parameters<typeof cancelOrder>[0], ctx)],
  ["reorder", (input, ctx) => reorder(input as Parameters<typeof reorder>[0], ctx)],
  // ── Intelligence tools — all use (input, ctx) signature
  ["get_customer_profile", (input, ctx) => getCustomerProfile(input as Parameters<typeof getCustomerProfile>[0], ctx)],
  ["get_recommendations", (input, ctx) => getRecommendations(input as Parameters<typeof getRecommendations>[0], ctx)],
  ["update_preferences", (input, ctx) => updatePreferences(input as Parameters<typeof updatePreferences>[0], ctx)],
  ["submit_review", (input, ctx) => submitReview(input as Parameters<typeof submitReview>[0], ctx)],
  ["get_also_added", (input, ctx) => getAlsoAdded(input as Parameters<typeof getAlsoAdded>[0], ctx)],
  ["get_ordered_together", (input, ctx) => getOrderedTogether(input as Parameters<typeof getOrderedTogether>[0], ctx)],
])

/**
 * Execute a tool by name.
 * Throws if the tool name is not registered.
 */
export async function executeTool(
  name: string,
  input: unknown,
  ctx: AgentContext,
): Promise<unknown> {
  const handler = handlers.get(name)
  if (!handler) {
    throw new Error(`Ferramenta desconhecida: ${name}`)
  }
  return handler(input, ctx)
}
