/**
 * Commerce-reference — domain types.
 *
 * A pared-down e-commerce surface that demonstrates the same patterns
 * IbateXas exercises (cart -> checkout -> payment -> fulfillment) without
 * the full production complexity. Every concept here exists in the real
 * IbateXas codebase too; the difference is that here the types are
 * self-contained and English-language.
 */

import type { IntentEnvelope, TaintPolicy } from "@adjudicate/core";

export type OrderIntentKind =
  | "cart.add_item" // customer adds a SKU + quantity to the cart
  | "cart.remove_item" // customer removes a line
  | "order.checkout" // converts cart to order, awaits payment
  | "order.confirm_payment" // payment provider webhook (TRUSTED)
  | "order.cancel"; // cancel a not-yet-shipped order

export type OrderStatus =
  | "shopping"
  | "awaiting_payment"
  | "paid"
  | "shipped"
  | "cancelled";

export interface CartLine {
  readonly sku: string;
  readonly quantity: number;
  readonly priceCentavos: number;
}

export interface Cart {
  readonly lines: ReadonlyArray<CartLine>;
  readonly totalCentavos: number;
}

export interface CatalogEntry {
  readonly sku: string;
  /** Hard inventory + UX cap. Quantities exceeding this are REWRITTEN-clamped. */
  readonly maxPerOrder: number;
  readonly priceCentavos: number;
}

export interface Order {
  readonly id: string;
  readonly status: OrderStatus;
  /** Set on `awaiting_payment`. */
  readonly paymentMethod: "pix" | "card" | null;
  /** External provider's payment status. Only meaningful while awaiting_payment. */
  readonly paymentStatus: "pending" | "confirmed" | "failed" | null;
}

export interface CommerceState {
  readonly customer: {
    readonly id: string | null;
    readonly isAuthenticated: boolean;
  };
  readonly cart: Cart;
  readonly order: Order | null;
  /** SKU -> catalog entry. Resolved by the runtime; LLM never sees this. */
  readonly catalog: ReadonlyMap<string, CatalogEntry>;
}

/** Domain-narrow envelope alias. */
export type CommerceEnvelope = IntentEnvelope<OrderIntentKind, unknown>;

/**
 * Taint requirements per intent kind.
 * - Customer-initiated (cart.*, order.checkout, order.cancel): UNTRUSTED.
 * - Provider webhooks (order.confirm_payment): TRUSTED — must originate
 *   from authenticated payment provider, not from the LLM.
 */
export const commerceTaintPolicy: TaintPolicy = {
  minimumFor(kind) {
    return kind === "order.confirm_payment" ? "TRUSTED" : "UNTRUSTED";
  },
};

/** PIX confirmation timeouts and signal identifiers — domain constants. */
export const PAYMENT_CONFIRMATION_SIGNAL = "payment.confirmed";
export const PAYMENT_DEFER_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
