// @example/commerce-reference — derived from the IbateXas order flow.
//
// Demonstrates the same kernel patterns IbateXas's production code uses
// (REWRITE on quantity-cap, DEFER on PIX-pending, refusals + auth gates
// + state-aware capability planning) in a self-contained, English form.

export {
  PAYMENT_CONFIRMATION_SIGNAL,
  PAYMENT_DEFER_TIMEOUT_MS,
  commerceTaintPolicy,
  type CartLine,
  type Cart,
  type CatalogEntry,
  type CommerceEnvelope,
  type CommerceState,
  type Order,
  type OrderIntentKind,
  type OrderStatus,
} from "./types.js";

export { commercePolicyBundle } from "./policies.js";

export {
  COMMERCE_TOOLS,
  commerceCapabilityPlanner,
} from "./capabilities.js";

export {
  refuseEmptyCart,
  refuseNoOrderToCancel,
  refuseNotAuthenticated,
  refuseOrderAlreadyShipped,
  refuseUnknownSku,
} from "./refusals.js";
