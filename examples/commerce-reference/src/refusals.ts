/**
 * Commerce-reference — refusal taxonomy.
 *
 * Typed builders for every refusal this domain emits. Two reasons to centralize:
 *
 *   1. The user-facing copy lives in one place (i18n later if needed).
 *   2. The machine-readable `code` is a stable contract — observability,
 *      analytics, and A/B-tested UI variants key off it.
 *
 * Keep the codes prefixed (`cart.*`, `order.*`, `auth.*`) and dotted —
 * BASIS_CODES vocabulary uses the same convention.
 */

import { refuse, type Refusal } from "@adjudicate/core";

// ── Auth refusals ───────────────────────────────────────────────────────────

export const refuseNotAuthenticated = (): Refusal =>
  refuse(
    "AUTH",
    "auth.not_authenticated",
    "Please sign in to continue with checkout.",
  );

// ── Cart-state refusals ─────────────────────────────────────────────────────

export const refuseEmptyCart = (): Refusal =>
  refuse(
    "STATE",
    "cart.empty",
    "Your cart is empty. Add an item before checking out.",
  );

export const refuseUnknownSku = (sku: string): Refusal =>
  refuse(
    "STATE",
    "cart.unknown_sku",
    `That product isn't in the catalog.`,
    `sku=${sku}`,
  );

// ── Order-state refusals ────────────────────────────────────────────────────

export const refuseOrderAlreadyShipped = (): Refusal =>
  refuse(
    "STATE",
    "order.already_shipped",
    "This order has already shipped and can no longer be modified.",
  );

export const refuseNoOrderToCancel = (): Refusal =>
  refuse(
    "STATE",
    "order.not_found",
    "We couldn't find an order to cancel.",
  );

// ── Business-rule refusals ──────────────────────────────────────────────────

export const refuseCheckoutWithoutShipping = (): Refusal =>
  refuse(
    "BUSINESS_RULE",
    "checkout.shipping_required",
    "Please confirm your shipping address before checkout.",
  );
