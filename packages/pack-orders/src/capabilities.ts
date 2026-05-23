/**
 * @ibatexas/pack-orders — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool visibility for the order domain. The LLM never sees
 * MUTATING tools (CLAUDE.md rule #9); MUTATING calls are captured as
 * `IntentEnvelope`s and adjudicated through the kernel. The planner
 * here decides which READ_ONLY tools the LLM may call and which intent
 * kinds it may propose per session context.
 *
 * The full state-aware planner lives in
 * `packages/llm-provider/src/capability-planner.ts` because it depends
 * on IbateXas's state-machine vocabulary (`stateValue` strings). This
 * file ships a context-only planner that is the Pack-shipped default —
 * adopters who don't have a state machine call this one; adopters who
 * do (IbateXas's API) compose their state-aware planner over this and
 * keep the Pack's `ToolClassification` as the source of truth for
 * tool-name → mutating/read-only mapping.
 *
 * Following the `pack-payments-pix` pattern: `ordersCapabilityPlanner`
 * is wrapped in `safePlan` so any future regression that exposes a
 * MUTATING tool to the LLM throws `PlanConformanceError` at boot
 * rather than silently leaking.
 */

import {
  filterReadOnly,
  safePlan,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm"
import type { OrderContext, OrderIntentKind, OrderState } from "./types.js"

/**
 * Order-domain tool classification. Mirrors the order-related entries
 * in `packages/llm-provider/src/machine/types.ts` `TOOL_CLASSIFICATION`
 * — kept narrow to just this Pack's surface so the planner's
 * `safePlan` wrap can assert "no MUTATING tool ever appears in
 * `visibleReadTools`".
 *
 * Tool naming is the legacy `snake_case` from the IbateXas tool
 * registry; the eventual `@adjudicate/tools` migration will introduce
 * versioned schemas without changing the planner contract.
 */
export const ORDER_TOOLS: ToolClassification = {
  READ_ONLY: new Set([
    "get_cart",
    "get_order_history",
    "check_order_status",
    "get_recommendations",
    "get_also_added",
    "get_ordered_together",
  ]),
  MUTATING: new Set([
    "get_or_create_cart",
    "add_to_cart",
    "update_cart",
    "remove_from_cart",
    "apply_coupon",
    "create_checkout",
    "cancel_order",
    "amend_order",
    "add_order_note",
    "reorder",
  ]),
}

/**
 * Tool → intent-kind mapping for the order domain. The intent-bridge
 * consumes this when translating an LLM-proposed tool call into an
 * `IntentEnvelope` for adjudication. Kept beside `ORDER_TOOLS` so
 * "what gates this tool?" is one lookup.
 */
export const ORDER_TOOL_TO_INTENT: Readonly<
  Record<string, OrderIntentKind>
> = {
  get_or_create_cart: "order.cart.ensure",
  add_to_cart: "order.item.add",
  update_cart: "order.item.update",
  remove_from_cart: "order.item.remove",
  apply_coupon: "order.coupon.apply",
  create_checkout: "order.checkout.create",
  cancel_order: "order.cancel",
  amend_order: "order.amend.request",
  add_order_note: "order.note.add",
  // `reorder` is a higher-level orchestration that produces multiple
  // `order.item.add` envelopes; not a single-intent map.
}

// ── Planner implementation ──────────────────────────────────────────────

/**
 * Default planner the Pack ships. Returns the Pack's read-only tool
 * surface, gated by the auth state in `OrderContext`. Adopters with a
 * richer state shape (IbateXas's `stateValue`-keyed `STATE_TOOLS`
 * lookup) compose this planner via wrapper or replace it outright in
 * `installPack(ordersPack, ...)`.
 */
const rawOrdersCapabilityPlanner: CapabilityPlanner<OrderState, OrderContext> =
  {
    plan(state, context): Plan {
      const isAuthenticated = state.ctx.customerId !== null
      const baseRead: string[] = [
        "get_cart",
        "check_order_status",
        "get_recommendations",
      ]
      if (isAuthenticated) {
        baseRead.push(
          "get_order_history",
          "get_also_added",
          "get_ordered_together",
        )
      }

      const allowedIntents: OrderIntentKind[] = [
        // Always proposable — the policy decides whether to refuse.
        "order.cart.ensure",
        "order.item.add",
        "order.item.update",
        "order.item.remove",
        "order.coupon.apply",
      ]
      if (isAuthenticated) {
        allowedIntents.push(
          "order.checkout.create",
          "order.cancel",
          "order.amend.request",
          "order.note.add",
        )
      }
      // `order.cancel.system` is NEVER LLM-proposable — the taint gate
      // enforces TRUSTED for system-only kinds (see types.ts taint
      // policy); the planner omits it for defence in depth.
      void context

      return {
        visibleReadTools: filterReadOnly(ORDER_TOOLS, baseRead),
        allowedIntents,
      }
    },
  }

/**
 * Wrapped via `safePlan` — every `plan()` invocation is asserted
 * against `ORDER_TOOLS` so a future regression that adds a MUTATING
 * tool name to `visibleReadTools` throws `PlanConformanceError`
 * loudly at boot. This is the recommended pattern for every Pack;
 * `pack-payments-pix` does the same with `PIX_TOOLS`.
 */
export const ordersCapabilityPlanner: CapabilityPlanner<
  OrderState,
  OrderContext
> = safePlan(rawOrdersCapabilityPlanner, ORDER_TOOLS)
