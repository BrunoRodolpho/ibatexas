// CapabilityPlanner implementation for IbateXas.
//
// Implements the security-sensitive capability-shaping decisions
// (STATE_TOOLS map, resolveTools, forbidden-concept lookup) behind the
// generic `@adjudicate/core/llm` CapabilityPlanner interface.
//
// The prompt-synthesizer is the IbateXas PromptRenderer (cosmetic,
// state-aware, pt-BR) and calls `resolveTools` + `getForbiddenConceptsFor`
// from here internally.
//
// When this code eventually ships as a published commerce-reference example,
// the body of the planner moves into that example package; the interface
// it implements (CapabilityPlanner) stays in @adjudicate/core/llm.

import type {
  CapabilityPlanner as FrameworkCapabilityPlanner,
  Plan,
} from "@adjudicate/core/llm"
import type { OrderContext } from "./machine/types.js"
import { TOOL_CLASSIFICATION } from "./machine/types.js"

// ── Allowed mutating-intent kinds per state family ────────────────────────────

const ALL_INTENT_KINDS = Array.from(TOOL_CLASSIFICATION.MUTATING)

// ── State → read-only tool list ───────────────────────────────────────────────

export const STATE_TOOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["idle", ["get_customer_profile", "search_products", "check_order_status", "get_order_history"]],
  ["first_contact", ["get_customer_profile", "search_products"]],
  ["browsing", ["search_products", "get_product_details", "check_inventory", "get_nutritional_info", "estimate_delivery", "check_order_status", "get_order_history"]],
  ["ordering.", ["search_products", "get_also_added", "get_ordered_together"]],
  ["checkout.collecting_pix_details", ["set_pix_details"]],
  ["checkout.reviewing_pix_details", []],
  ["checkout.", []],
  ["post_order.cancelling", []],
  ["post_order.amending", []],
  ["post_order.regenerating_pix", []],
  ["post_order.", ["get_loyalty_balance", "check_order_status", "check_payment_status", "search_products"]],
  ["reservation", ["check_table_availability", "get_my_reservations"]],
  ["support", ["handoff_to_human"]],
  ["loyalty_check", ["get_loyalty_balance"]],
  ["reorder", ["get_order_history", "search_products"]],
  ["objection", ["schedule_follow_up"]],
  ["fallback", ["search_products", "get_customer_profile", "estimate_delivery", "check_order_status", "get_order_history"]],
]

/**
 * Resolve the tools the LLM is allowed to see in the given state.
 *
 * The LLM never sees MUTATING tools — this function only returns READ_ONLY
 * names. The tool registry's `executeTool()` separately captures MUTATING
 * calls as intents; those are not exposed through the prompt.
 */
export function resolveTools(stateValue: string, ctx?: OrderContext): string[] {
  for (const [pattern, tools] of STATE_TOOLS) {
    if (pattern.endsWith(".")) {
      if (stateValue.startsWith(pattern) || stateValue === pattern.slice(0, -1)) {
        // Defensive: closed + item_unavailable never shows search_products.
        if (stateValue === "ordering.item_unavailable" && ctx?.mealPeriod === "closed") {
          return tools.filter((t) => t !== "search_products")
        }
        return [...tools]
      }
    } else {
      if (stateValue === pattern) return [...tools]
    }
  }
  return []
}

// ── Forbidden concepts per state family ───────────────────────────────────────

/**
 * Negative-constraint phrases injected into the rendered prompt.
 * These are the same phrases the validation-layer checks post-hoc; surfacing
 * them in the prompt reduces the rate of post-LLM rewrites.
 */
export function getForbiddenConceptsFor(stateValue: string): ReadonlyArray<string> {
  if (stateValue === "post_order" || stateValue.startsWith("post_order.")) {
    return [
      "pedido cancelado",
      "pedido alterado",
      "alteração confirmada",
      "cancelamento confirmado",
    ]
  }
  if (stateValue.startsWith("checkout.")) {
    return [
      "pedido confirmado",
      "pedido registrado",
      "processando",
      "estou finalizando",
    ]
  }
  if (stateValue.startsWith("ordering.")) {
    return ["pedido registrado", "pedido confirmado", "confirmação em instantes"]
  }
  return []
}

// ── Intent kinds allowed per state (Phase I — taints proposals by state) ──────

/**
 * Which mutating intent kinds the LLM may propose in this state. Today we
 * allow any of the `TOOL_CLASSIFICATION.MUTATING` tools in any "authorized"
 * state; this narrows further in Phase J when adjudicate() is the sole gate.
 */
export function allowedIntentsFor(stateValue: string): ReadonlyArray<string> {
  // In states where no READ tools are exposed, no intents may be proposed
  // either (e.g. post_order.cancelling runs a deterministic action).
  const readTools = resolveTools(stateValue)
  if (readTools.length === 0) return []
  return ALL_INTENT_KINDS
}

// ── CapabilityPlanner adapter (framework interface) ──────────────────────────

/**
 * Adapter conforming to the generic `@adjudicate/core/llm.CapabilityPlanner<S, C>`
 * interface. Consumers of the framework interface can swap this implementation
 * without touching the renderer.
 */
export const orderCapabilityPlanner: FrameworkCapabilityPlanner<
  string,
  OrderContext
> = {
  plan(stateValue, ctx): Plan {
    return {
      visibleReadTools: resolveTools(stateValue, ctx),
      allowedIntents: allowedIntentsFor(stateValue),
      forbiddenConcepts: getForbiddenConceptsFor(stateValue),
    }
  },
}
