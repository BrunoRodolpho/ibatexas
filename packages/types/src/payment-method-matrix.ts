// Payment method switch matrix — determines which method switches are allowed
// based on the order type. Cash is blocked for delivery orders (security risk).
//
// Decision matrix §4.4:
//   PIX → cash:  ❌ delivery, ✅ pickup, ✅ dine_in
//   card → cash: ❌ delivery, ✅ pickup, ✅ dine_in
//   cash → PIX:  ✅ all
//   cash → card: ✅ all
//   PIX ↔ card:  ✅ all

import type { PaymentMethod } from "./payment-status.js"
import type { OrderType } from "./order-type.js"

/**
 * Check if switching from one payment method to another is allowed
 * for the given order type.
 *
 * Rules:
 * - Same method → always false (no-op, not a switch)
 * - Switching TO cash on delivery orders is blocked
 * - All other switches are allowed
 */
export function canSwitchPaymentMethod(
  from: PaymentMethod,
  to: PaymentMethod,
  orderType: OrderType,
): boolean {
  // Same method — not a switch
  if (from === to) return false

  // Cash is not allowed for delivery orders
  if (to === "cash" && orderType === "delivery") return false

  return true
}
