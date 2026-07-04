// Shared narrow of an OrderProjection.itemsJson element.
//
// `itemsJson` is a Prisma `Json?` column, so it arrives UNTYPED and must be
// narrowed by hand wherever a read-only projection service reads line items.
// This is the ONE place that narrow + parse lives — shared by the read-over-
// projection services (order-analytics, kitchen) so the idiom is reused, not
// cloned. Matches OrderEventItem (packages/types/src/order-events.ts):
// { productId, variantId, title, quantity, priceInCentavos }. Kept as a LOCAL
// domain narrow (not a value import of `@ibatexas/types`) — the Json column is
// untyped regardless, and the domain index path must not value-import types.

/** The narrow shape we read off each `itemsJson` element. */
export interface LineItem {
  productId: string
  title: string
  quantity: number
  priceInCentavos: number
}

/** Narrow a raw `itemsJson` value to a LineItem[] (non-array → []). */
export function parseLineItems(itemsJson: unknown): LineItem[] {
  if (!Array.isArray(itemsJson)) return []
  return itemsJson as LineItem[]
}
