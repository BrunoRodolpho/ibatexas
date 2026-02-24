// Tool registry — maps Claude tool names to their execute handlers.
// Add new tools here as they are implemented in packages/tools.

import { searchProducts, SearchProductsTool, getProductDetails, GetProductDetailsTool } from "@ibatexas/tools"
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
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

type ToolHandler = (input: unknown, ctx: AgentContext) => Promise<unknown>

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
