/**
 * Commerce-reference — CapabilityPlanner.
 *
 * State-aware tool visibility. The same customer in different order
 * states sees a different tool surface:
 *
 *   shopping         — catalog read + cart mutations
 *   awaiting_payment — read-only confirmation tools (no cart edits)
 *   paid             — read-only invoice/tracking
 *   shipped          — read-only (no cancellation, no edits)
 *   cancelled        — read-only confirmation
 *
 * MUTATING tools the LLM cannot see in a given state literally do not
 * appear in the serialized tool list — `filterReadOnly` enforces the
 * partition structurally.
 */

import {
  filterReadOnly,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm";
import type { CommerceState, OrderStatus } from "./types.js";

export const COMMERCE_TOOLS: ToolClassification = {
  READ_ONLY: new Set([
    "search_catalog",
    "view_cart",
    "view_order",
    "track_shipment",
  ]),
  MUTATING: new Set([
    "add_to_cart",
    "remove_from_cart",
    "checkout",
    "cancel_order",
  ]),
};

const TOOLS_BY_STATE: Record<OrderStatus, ReadonlyArray<string>> = {
  shopping: [
    "search_catalog",
    "view_cart",
    "add_to_cart",
    "remove_from_cart",
    "checkout",
  ],
  awaiting_payment: ["view_cart", "view_order"],
  paid: ["view_order", "track_shipment", "cancel_order"],
  shipped: ["view_order", "track_shipment"],
  cancelled: ["view_order"],
};

const INTENTS_BY_STATE: Record<OrderStatus, ReadonlyArray<string>> = {
  shopping: ["cart.add_item", "cart.remove_item", "order.checkout"],
  awaiting_payment: [], // LLM cannot propose mutations while parked
  paid: ["order.cancel"],
  shipped: [],
  cancelled: [],
};

export const commerceCapabilityPlanner: CapabilityPlanner<CommerceState> = {
  plan(state): Plan {
    const status: OrderStatus = state.order?.status ?? "shopping";
    const allTools = TOOLS_BY_STATE[status] ?? [];
    return {
      visibleReadTools: filterReadOnly(COMMERCE_TOOLS, allTools),
      allowedIntents: INTENTS_BY_STATE[status] ?? [],
      forbiddenConcepts: [
        // Concepts the LLM must not emit at any time.
        "guaranteed delivery",
        "free shipping",
        "exclusive discount",
      ],
    };
  },
};
