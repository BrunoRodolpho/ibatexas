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
// Task 07 (M1): the raw planner is wrapped in `safePlan(...)` from
// `@adjudicate/core/llm` — every `.plan(state, ctx)` call asserts no
// MUTATING tool leaks into `visibleReadTools`. The exported
// `orderCapabilityPlanner` IS the wrapped planner; consumers always go
// through it. The split between `visibleReadTools` (READ_ONLY only) and
// `allowedIntents` (MUTATING proposals) is now structural — the framework's
// `Plan` shape is authoritative and the responder consults
// `plan.allowedIntents` before invoking `adjudicate()`.
//
// When this code eventually ships as a published commerce-reference example,
// the body of the planner moves into that example package; the interface
// it implements (CapabilityPlanner) stays in @adjudicate/core/llm.

import {
  safePlan,
  type CapabilityPlanner as FrameworkCapabilityPlanner,
  type Plan,
} from "@adjudicate/core/llm"
import type { OrderContext } from "./machine/types.js"
import { TOOL_CLASSIFICATION } from "./machine/types.js"

// ── State → tool list (full visibility set the LLM has historically seen) ────
//
// Historically (pre-task-07) IbateXas's `resolveTools` returned a single mixed
// list per state — both READ tools the LLM calls directly AND MUTATING tools
// the LLM may PROPOSE (which are routed through the intent bridge). The
// framework's `Plan` interface splits these: `visibleReadTools` (READ_ONLY)
// vs `allowedIntents` (mutating intent identities). The planner below
// partitions this mixed list against `TOOL_CLASSIFICATION`. The mixed list
// below is preserved as the source of truth so the LLM's visible-tool surface
// stays identical (see decisions-log §D7).
//
// Pattern matching: `"foo."` is a prefix match for nested states (`foo.bar`,
// `foo.baz` — XState compound states); a bare key (`"idle"`) is an exact
// match. First match wins; order is significant.

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
 * Resolve the tools the LLM is allowed to SEE in the given state — the
 * union of `Plan.visibleReadTools` + `Plan.allowedIntents`.
 *
 * The framework split between READ vs proposable-MUTATING is reflected in
 * the `Plan` shape; the LLM tool-call surface (Anthropic `tools` array)
 * still gets the union, because mutating tools are intercepted at
 * `executeTool` time and routed through the intent bridge — the LLM needs
 * to know they exist to propose them. The state-gate in `llm-responder.ts`
 * uses this union for ingress filtering; the new planner-violation gate
 * (task 07) consults `plan.allowedIntents` specifically.
 *
 * Behavior preserved: this function returns the SAME list it returned
 * before task 07 — only the framing changed.
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

// ── Plan partition helpers (READ vs MUTATING) ────────────────────────────────
//
// Task 07: `safePlan` requires `visibleReadTools` to be pure READ_ONLY. We
// partition each state's mixed tool list against `TOOL_CLASSIFICATION` —
// MUTATING entries become `allowedIntents`, READ_ONLY entries become
// `visibleReadTools`. Unknown names route to `visibleReadTools` (the safer
// option — they cannot be proposed without an entry in MUTATING anyway).

function partitionTools(
  tools: ReadonlyArray<string>,
): { readonly read: ReadonlyArray<string>; readonly intents: ReadonlyArray<string> } {
  const read: string[] = []
  const intents: string[] = []
  for (const name of tools) {
    if (TOOL_CLASSIFICATION.MUTATING.has(name as never)) {
      intents.push(name)
    } else {
      // READ_ONLY OR unclassified — keep on the read side. The state-gate
      // still requires the name to be in the union list, so unclassified
      // names that slipped past TOOL_CLASSIFICATION won't suddenly become
      // freely callable; they just appear in the visible-read bucket.
      read.push(name)
    }
  }
  return { read, intents }
}

/**
 * Resolve the READ-only tools the LLM may call directly in `stateValue`.
 * Exposed for tests + audit consumers that need the partitioned view
 * without going through the planner adapter.
 */
export function resolveReadTools(
  stateValue: string,
  ctx?: OrderContext,
): ReadonlyArray<string> {
  return partitionTools(resolveTools(stateValue, ctx)).read
}

/**
 * Resolve the MUTATING intent identities the LLM may PROPOSE in
 * `stateValue`. Today these are tool names (matching `intent.toolName`);
 * once domain-specific intent kinds replace the generic `order.tool.propose`
 * envelope kind, the mapping can shift to those kinds without changing the
 * STATE_TOOLS table.
 *
 * In states where the deterministic kernel-executor (task 06) handles a
 * mutation on behalf of the LLM, the corresponding intent is intentionally
 * NOT in the state's mixed list — so it's absent here too. The kernel-
 * executor path is route-driven (XState transitions) and does not flow
 * through the LLM-proposed intent surface.
 */
export function allowedIntentsFor(
  stateValue: string,
  ctx?: OrderContext,
): ReadonlyArray<string> {
  return partitionTools(resolveTools(stateValue, ctx)).intents
}

// ── CapabilityPlanner adapter (framework interface) ──────────────────────────

/**
 * Raw planner — partitions `STATE_TOOLS` against `TOOL_CLASSIFICATION` and
 * returns a `Plan { visibleReadTools, allowedIntents }`. Wrapped in
 * `safePlan(...)` below; exported separately for tests that need to drive
 * a deliberately-broken raw planner through `safePlan` and observe the
 * conformance assertion.
 */
export const rawOrderCapabilityPlanner: FrameworkCapabilityPlanner<
  string,
  OrderContext | undefined
> = {
  plan(stateValue, ctx): Plan {
    const { read, intents } = partitionTools(resolveTools(stateValue, ctx))
    return {
      visibleReadTools: read,
      allowedIntents: intents,
    }
  },
}

/**
 * Adapter conforming to `@adjudicate/core/llm.CapabilityPlanner<S, C>`.
 * Wrapped in `safePlan(...)` so every `.plan()` call asserts the strongest
 * claim of the framework: no MUTATING tool name leaks into
 * `visibleReadTools`. A misconfigured STATE_TOOLS row fails LOUDLY at
 * runtime — the LLM never sees the leaked surface.
 *
 * `safePlan` accepts an optional `Pack` argument for the second assertion
 * (allowedIntents ⊆ pack.intents). We don't pass one today because the
 * IbateXas LLM-proposed mutating surface is the tool-name set (today's
 * envelope kind is the generic `order.tool.propose` — the real identity is
 * `intent.toolName`). When the planner mapping shifts to domain-specific
 * intent kinds — e.g. `order.cart.add` — wiring the Pack here will
 * additionally guard the allowedIntents leak path described in
 * `assertPlanSubsetOfPack`.
 *
 * Note: `forbiddenConcepts` is intentionally not part of the framework
 * `Plan` shape — it's a cosmetic prompt-rendering concern, not a security
 * boundary. The PromptRenderer calls `getForbiddenConceptsFor(stateValue)`
 * directly.
 */
export const orderCapabilityPlanner: FrameworkCapabilityPlanner<
  string,
  OrderContext | undefined
> = safePlan(rawOrderCapabilityPlanner, TOOL_CLASSIFICATION)
