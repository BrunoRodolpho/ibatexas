// Tool registry — maps Claude tool names to their execute handlers.
// Add new tools here as they are implemented in packages/tools.

import {
  searchProducts,
  SearchProductsTool,
  getProductDetails,
  GetProductDetailsTool,
  estimateDelivery,
  EstimateDeliveryTool,
  checkInventory,
  CheckInventoryTool,
  getNutritionalInfo,
  GetNutritionalInfoTool,
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
  getOrCreateCart,
  GetOrCreateCartTool,
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
  checkPaymentStatus,
  CheckPaymentStatusTool,
  cancelOrder,
  CancelOrderTool,
  amendOrder,
  AmendOrderTool,
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
  // Support tools
  handoffToHuman,
  HandoffToHumanTool,
  // Intelligence: follow-up
  scheduleFollowUp,
  ScheduleFollowUpTool,
  // Loyalty
  getLoyaltyBalance,
  GetLoyaltyBalanceTool,
  // PIX regeneration
  regeneratePix,
  RegeneratePixTool,
  // PIX details collection
  setPixDetails,
  SetPixDetailsTool,
  SetPixDetailsInputSchema,
} from "@ibatexas/tools"
import type { AgentContext } from "@ibatexas/types"
import {
  SearchProductsInputSchema,
  CheckAvailabilityInputSchema,
  CreateReservationInputSchema,
  ModifyReservationInputSchema,
  CancelReservationInputSchema,
  GetMyReservationsInputSchema,
  JoinWaitlistInputSchema,
  GetCartInputSchema,
  GetOrCreateCartInputSchema,
  AddToCartInputSchema,
  UpdateCartInputSchema,
  RemoveFromCartInputSchema,
  ApplyCouponInputSchema,
  CreateCheckoutInputSchema,
  GetOrderHistoryInputSchema,
  CheckOrderStatusInputSchema,
  CancelOrderInputSchema,
  AmendOrderInputSchema,
  ReorderInputSchema,
  GetCustomerProfileInputSchema,
  UpdatePreferencesInputSchema,
  SubmitReviewInputSchema,
  GetAlsoAddedInputSchema,
  GetOrderedTogetherInputSchema,
  CheckInventoryInputSchema,
  GetNutritionalInfoInputSchema,
  HandoffToHumanInputSchema,
  ScheduleFollowUpInputSchema,
  RegeneratePixInputSchema,
} from "@ibatexas/types"
import { z } from "zod"
import type { Tool } from "@anthropic-ai/sdk/resources/index.js"
import { buildEnvelope } from "@adjudicate/core"
import {
  TOOL_CLASSIFICATION,
  type ToolIntent,
  type ToolProposePayload,
} from "./machine/types.js"

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
  toAnthropicTool(CheckInventoryTool),
  toAnthropicTool(GetNutritionalInfoTool),
  // Reservation tools
  toAnthropicTool(CheckTableAvailabilityTool),
  toAnthropicTool(CreateReservationTool),
  toAnthropicTool(ModifyReservationTool),
  toAnthropicTool(CancelReservationTool),
  toAnthropicTool(GetMyReservationsTool),
  toAnthropicTool(JoinWaitlistTool),
  // Cart tools
  toAnthropicTool(GetOrCreateCartTool),
  toAnthropicTool(GetCartTool),
  toAnthropicTool(AddToCartTool),
  toAnthropicTool(UpdateCartTool),
  toAnthropicTool(RemoveFromCartTool),
  toAnthropicTool(ApplyCouponTool),
  toAnthropicTool(CreateCheckoutTool),
  toAnthropicTool(GetOrderHistoryTool),
  toAnthropicTool(CheckOrderStatusTool),
  toAnthropicTool(CheckPaymentStatusTool),
  toAnthropicTool(CancelOrderTool),
  toAnthropicTool(AmendOrderTool),
  toAnthropicTool(ReorderTool),
  // Intelligence tools
  toAnthropicTool(GetCustomerProfileTool),
  toAnthropicTool(GetRecommendationsTool),
  toAnthropicTool(UpdatePreferencesTool),
  toAnthropicTool(SubmitReviewTool),
  toAnthropicTool(GetAlsoAddedTool),
  toAnthropicTool(GetOrderedTogetherTool),
  // Support tools
  toAnthropicTool(HandoffToHumanTool),
  // Intelligence: follow-up
  toAnthropicTool(ScheduleFollowUpTool),
  // Loyalty
  toAnthropicTool(GetLoyaltyBalanceTool),
  // PIX regeneration
  toAnthropicTool(RegeneratePixTool),
  // PIX details collection
  toAnthropicTool(SetPixDetailsTool),
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

type ToolHandler = (input: unknown, ctx: AgentContext) => Promise<unknown>

/**
 * Higher-order function: ALWAYS injects customerId from AgentContext, ignoring any
 * LLM-supplied value. Throws early when authentication is required but customerId
 * is missing from the session context.
 */
// Always override customerId from ctx; never trust LLM input
function withCustomerId<T extends { customerId?: string }>(
  fn: (input: T) => Promise<unknown>,
): ToolHandler {
  return (input, ctx) => {
    const i = input as T
    if (!ctx.customerId) {
      throw new Error("Autenticação necessária. O cliente precisa se identificar para usar esta funcionalidade.")
    }
    return fn({ ...i, customerId: ctx.customerId })
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
  [
    "check_inventory",
    (input) => checkInventory(input as Parameters<typeof checkInventory>[0]),
  ],
  [
    "get_nutritional_info",
    (input) => getNutritionalInfo(input as Parameters<typeof getNutritionalInfo>[0]),
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
  ["get_or_create_cart", (input, ctx) => getOrCreateCart(input, ctx)],
  ["get_cart", (input, ctx) => getCart(input as Parameters<typeof getCart>[0], ctx)],
  ["add_to_cart", (input, ctx) => addToCart(input as Parameters<typeof addToCart>[0], ctx)],
  ["update_cart", (input, ctx) => updateCart(input as Parameters<typeof updateCart>[0], ctx)],
  ["remove_from_cart", (input, ctx) => removeFromCart(input as Parameters<typeof removeFromCart>[0], ctx)],
  ["apply_coupon", (input, ctx) => applyCoupon(input as Parameters<typeof applyCoupon>[0], ctx)],
  ["create_checkout", (input, ctx) => createCheckout(input as Parameters<typeof createCheckout>[0], ctx)],
  ["get_order_history", (input, ctx) => getOrderHistory(input as Parameters<typeof getOrderHistory>[0], ctx)],
  ["check_order_status", (input, ctx) => checkOrderStatus(input as Parameters<typeof checkOrderStatus>[0], ctx)],
  ["check_payment_status", (input, ctx) => checkPaymentStatus(input as Parameters<typeof checkPaymentStatus>[0], ctx)],
  ["cancel_order", (input, ctx) => cancelOrder(input as Parameters<typeof cancelOrder>[0], ctx)],
  ["amend_order", (input, ctx) => amendOrder(input as Parameters<typeof amendOrder>[0], ctx)],
  ["reorder", (input, ctx) => reorder(input as Parameters<typeof reorder>[0], ctx)],
  // ── Intelligence tools — all use (input, ctx) signature
  ["get_customer_profile", (input, ctx) => getCustomerProfile(input as Parameters<typeof getCustomerProfile>[0], ctx)],
  ["get_recommendations", (input, ctx) => getRecommendations(input as Parameters<typeof getRecommendations>[0], ctx)],
  ["update_preferences", (input, ctx) => updatePreferences(input as Parameters<typeof updatePreferences>[0], ctx)],
  ["submit_review", (input, ctx) => submitReview(input as Parameters<typeof submitReview>[0], ctx)],
  ["get_also_added", (input, ctx) => getAlsoAdded(input as Parameters<typeof getAlsoAdded>[0], ctx)],
  ["get_ordered_together", (input, ctx) => getOrderedTogether(input as Parameters<typeof getOrderedTogether>[0], ctx)],
  // ── Support tools
  ["handoff_to_human", (input) => handoffToHuman(input as Parameters<typeof handoffToHuman>[0])],
  // ── Intelligence: follow-up
  ["schedule_follow_up", (input, ctx) => scheduleFollowUp(input as Parameters<typeof scheduleFollowUp>[0], ctx)],
  // ── Loyalty
  ["get_loyalty_balance", (input, ctx) => getLoyaltyBalance(input as Parameters<typeof getLoyaltyBalance>[0], ctx)],
  // ── PIX regeneration
  ["regenerate_pix", (input, ctx) => regeneratePix(input as Parameters<typeof regeneratePix>[0], ctx)],
  // ── PIX details collection — no withCustomerId wrapper (works for all customers)
  ["set_pix_details", (input, ctx) => setPixDetails(input as Parameters<typeof setPixDetails>[0], ctx)],
])

// Centralized Zod validation before tool dispatch.
// Maps tool names to their Zod input schemas. Tools without a dedicated schema
// in @ibatexas/types use a permissive z.looseObject({}) (validated internally).
// Tools wrapped by withCustomerId use .partial({ customerId: true }) because customerId
// is injected from AgentContext AFTER Zod validation, not supplied by the LLM.
const toolInputSchemas = new Map<string, z.ZodTypeAny>([
  ["search_products", SearchProductsInputSchema],
  ["get_product_details", z.strictObject({ productId: z.string() })],
  [
    "estimate_delivery",
    z
      .object({ cep: z.string().optional(), latitude: z.number().optional(), longitude: z.number().optional() })
      .strict()
      .refine((v) => v.cep !== undefined || (v.latitude !== undefined && v.longitude !== undefined), {
        message: "Informe um CEP ou coordenadas de localização (latitude + longitude).",
      }),
  ],
  ["check_inventory", CheckInventoryInputSchema],
  ["get_nutritional_info", GetNutritionalInfoInputSchema],
  ["check_table_availability", CheckAvailabilityInputSchema],
  ["create_reservation", CreateReservationInputSchema.partial({ customerId: true })],
  ["modify_reservation", ModifyReservationInputSchema.partial({ customerId: true })],
  ["cancel_reservation", CancelReservationInputSchema.partial({ customerId: true })],
  ["get_my_reservations", GetMyReservationsInputSchema.partial({ customerId: true })],
  ["join_waitlist", JoinWaitlistInputSchema.partial({ customerId: true })],
  ["get_or_create_cart", GetOrCreateCartInputSchema],
  ["get_cart", GetCartInputSchema],
  ["add_to_cart", AddToCartInputSchema],
  ["update_cart", UpdateCartInputSchema],
  ["remove_from_cart", RemoveFromCartInputSchema],
  ["apply_coupon", ApplyCouponInputSchema],
  ["create_checkout", CreateCheckoutInputSchema],
  ["get_order_history", GetOrderHistoryInputSchema],
  ["check_order_status", CheckOrderStatusInputSchema],
  ["cancel_order", CancelOrderInputSchema],
  ["amend_order", AmendOrderInputSchema],
  ["check_payment_status", z.object({ orderId: z.string() }).strict()],
  ["reorder", ReorderInputSchema],
  ["get_customer_profile", GetCustomerProfileInputSchema],
  ["get_recommendations", z.object({ customerId: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }).strict()],
  ["update_preferences", UpdatePreferencesInputSchema],
  ["submit_review", SubmitReviewInputSchema],
  ["get_also_added", GetAlsoAddedInputSchema],
  ["get_ordered_together", GetOrderedTogetherInputSchema],
  ["handoff_to_human", HandoffToHumanInputSchema],
  ["schedule_follow_up", ScheduleFollowUpInputSchema],
  ["get_loyalty_balance", z.object({ customerId: z.string().optional() }).strict()],
  ["regenerate_pix", RegeneratePixInputSchema],
  ["set_pix_details", SetPixDetailsInputSchema],
])

// ── Tool execution result types ──────────────────────────────────────────────

/**
 * Discriminated union for tool execution results.
 *
 * - `result`: The tool was executed and produced data (READ_ONLY tools).
 * - `intent`: The tool is MUTATING — captured as an intent for the kernel to
 *   validate and execute. The LLM proposed the call; the Machine decides.
 */
export type ToolExecutionResult =
  | { kind: "result"; data: unknown }
  | { kind: "intent"; intent: ToolIntent }

/**
 * Execute a tool by name with the Zero-Trust intent bridge.
 *
 * READ_ONLY tools are executed immediately and return `{ kind: "result" }`.
 * MUTATING tools are NOT executed — they return `{ kind: "intent" }` so the
 * caller (llm-responder) can pass the intent to the kernel for validation.
 *
 * Validates input against the Zod schema before dispatch.
 * Throws if the tool name is not registered.
 */
export async function executeTool(
  name: string,
  input: unknown,
  ctx: AgentContext,
  toolUseId?: string,
): Promise<ToolExecutionResult> {
  const handler = handlers.get(name)
  if (!handler) {
    throw new Error(`Ferramenta desconhecida: ${name}`)
  }

  // Validate input with Zod before calling handler
  const schema = toolInputSchemas.get(name)
  if (schema) {
    schema.parse(input)
  }

  // READ_ONLY tools: execute immediately, return result
  if (TOOL_CLASSIFICATION.READ_ONLY.has(name)) {
    const data = await handler(input, ctx)
    return { kind: "result", data }
  }

  // MUTATING tools: capture as intent, don't execute.
  // The caller (llm-responder) will pass this to the kernel for validation.
  // Phase B: wrap in a versioned IntentEnvelope alongside legacy fields.
  const payload: ToolProposePayload = {
    toolName: name,
    input,
    toolUseId: toolUseId ?? "",
  }
  const envelope = buildEnvelope({
    kind: "order.tool.propose",
    payload,
    actor: { principal: "llm", sessionId: ctx.sessionId },
    // User message is the ultimate source of the LLM's tool proposal.
    // v1.0 payload-level taint; field-level ships in v1.1 per docs/taint.md.
    taint: "UNTRUSTED",
  })
  return {
    kind: "intent",
    intent: {
      toolName: name,
      input,
      toolUseId: toolUseId ?? "",
      envelope,
    },
  }
}

/**
 * Execute a tool directly, bypassing the intent bridge.
 *
 * Used by the kernel executor path (machine/actions.ts) and for executing
 * intents that have been validated and approved by the machine. This function
 * ALWAYS executes the tool handler — no read-only/mutating classification.
 *
 * Validates input against the Zod schema before dispatch.
 * Throws if the tool name is not registered.
 */
export async function executeToolDirect(
  name: string,
  input: unknown,
  ctx: AgentContext,
): Promise<unknown> {
  const handler = handlers.get(name)
  if (!handler) {
    throw new Error(`Ferramenta desconhecida: ${name}`)
  }

  // Validate input with Zod before calling handler
  const schema = toolInputSchemas.get(name)
  if (schema) {
    schema.parse(input)
  }

  return handler(input, ctx)
}
