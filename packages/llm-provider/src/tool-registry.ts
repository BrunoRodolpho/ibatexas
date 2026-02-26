// Tool registry — maps Claude tool names to their execute handlers.
// Add new tools here as they are implemented in packages/tools.

import {
  searchProducts,
  SearchProductsTool,
  getProductDetails,
  GetProductDetailsTool,
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
  // Reservation tools
  toAnthropicTool(CheckTableAvailabilityTool),
  toAnthropicTool(CreateReservationTool),
  toAnthropicTool(ModifyReservationTool),
  toAnthropicTool(CancelReservationTool),
  toAnthropicTool(GetMyReservationsTool),
  toAnthropicTool(JoinWaitlistTool),
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
    (input) => {
      const { productId } = input as { productId: string }
      return getProductDetails(productId)
    },
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
