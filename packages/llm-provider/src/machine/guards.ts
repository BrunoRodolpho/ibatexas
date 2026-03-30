// Guard functions for the XState order machine.
// All guards are deterministic — NO LLM involvement.
// They inspect OrderContext and event payloads to make binary decisions.

import type { OrderContext, ItemCategory } from "./types.js"

// ── Authentication guards ────────────────────────────────────────────────────

export function isAuthenticated(ctx: OrderContext): boolean {
  return ctx.customerId !== null
}

export function isWhatsApp(ctx: OrderContext): boolean {
  return ctx.channel === "whatsapp"
}

export function isNewCustomer(ctx: OrderContext): boolean {
  return ctx.isNewCustomer
}

/** WhatsApp users are always considered authenticated (phone = identity). */
export function canCheckout(ctx: OrderContext): boolean {
  return ctx.channel === "whatsapp" || ctx.customerId !== null
}

// ── Cart guards ──────────────────────────────────────────────────────────────

export function isCartEmpty(ctx: OrderContext): boolean {
  return ctx.items.length === 0
}

export function hasCartItems(ctx: OrderContext): boolean {
  return ctx.items.length > 0
}

// ── Slot guards ──────────────────────────────────────────────────────────────

export function allSlotsFilled(ctx: OrderContext): boolean {
  return ctx.fulfillment !== null && ctx.paymentMethod !== null
}

export function hasFulfillment(ctx: OrderContext): boolean {
  return ctx.fulfillment !== null
}

export function hasPaymentMethod(ctx: OrderContext): boolean {
  return ctx.paymentMethod !== null
}

export function isValidPayment(method: string): boolean {
  return ["pix", "card", "cash"].includes(method)
}

// ── Upsell guards ────────────────────────────────────────────────────────────

const MAIN_CATEGORIES: ItemCategory[] = ["meat", "sandwich", "combo"]

export function shouldUpsell(ctx: OrderContext): boolean {
  if (ctx.isCombo) return false
  if (ctx.upsellRound >= 2) return false
  if (!ctx.hasMainDish) return false
  return !ctx.hasSide || !ctx.hasDrink
}

/** Recalculate hasMainDish/hasSide/hasDrink/isCombo from items array. */
export function computeCartFlags(items: OrderContext["items"]): {
  hasMainDish: boolean
  hasSide: boolean
  hasDrink: boolean
  isCombo: boolean
} {
  let hasMainDish = false
  let hasSide = false
  let hasDrink = false
  let isCombo = false

  for (const item of items) {
    if (MAIN_CATEGORIES.includes(item.category)) hasMainDish = true
    if (item.category === "side") hasSide = true
    if (item.category === "drink") hasDrink = true
    if (item.category === "combo") isCombo = true
  }

  return { hasMainDish, hasSide, hasDrink, isCombo }
}

// ── Delivery guards ──────────────────────────────────────────────────────────

export function isPickup(ctx: OrderContext): boolean {
  return ctx.fulfillment === "pickup"
}

export function isDelivery(ctx: OrderContext): boolean {
  return ctx.fulfillment === "delivery"
}
