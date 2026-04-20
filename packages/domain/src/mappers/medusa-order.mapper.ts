// Medusa → domain mapping layer.
// Isolates the projection/event system from Medusa schema drift.
// All Medusa-to-domain conversions go through these functions.

import type { OrderEventItem } from "@ibatexas/types"
import type { MedusaOrderRaw } from "@ibatexas/types"

/** Current schema version for itemsJson stored in OrderProjection. */
export const ITEMS_SCHEMA_VERSION = 1

// ── Extended Medusa shape (with fields returned by admin API expand) ────────

export interface MedusaOrderExpanded extends MedusaOrderRaw {
  subtotal?: number
  shipping_total?: number
  metadata?: Record<string, string>
  customer?: {
    id?: string
    first_name?: string
    last_name?: string
    email?: string
    phone?: string
  }
  shipping_address?: {
    address_1?: string
    city?: string
    postal_code?: string
  }
  items?: Array<{
    id?: string
    product_id?: string
    variant_id?: string
    title?: string
    quantity?: number
    unit_price?: number
  }>
}

// ── Input type for OrderProjection creation ─────────────────────────────────

export interface CreateOrderProjectionInput {
  id: string
  displayId: number
  customerId: string | null
  customerEmail: string | null
  customerName: string | null
  customerPhone: string | null
  fulfillmentStatus: string
  paymentStatus: string | null
  totalInCentavos: number
  subtotalInCentavos: number
  shippingInCentavos: number
  itemCount: number
  itemsJson: OrderEventItem[]
  itemsSchemaVersion: number
  shippingAddressJson: Record<string, string | undefined> | null
  deliveryType: string | null
  paymentMethod: string | null
  tipInCentavos: number
  medusaCreatedAt: Date
}

// ── Mappers ─────────────────────────────────────────────────────────────────

function buildCustomerName(customer?: { first_name?: string; last_name?: string }): string | null {
  if (!customer) return null
  const full = `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim()
  return full || null
}

/**
 * Convert Medusa item array to typed OrderEventItem[].
 * Prices from Medusa are in reais — caller must convert to centavos before calling,
 * or pass `pricesInCentavos: true` if already converted.
 */
export function toOrderEventItems(
  medusaItems: MedusaOrderExpanded["items"],
  pricesInCentavos = false,
): OrderEventItem[] {
  if (!Array.isArray(medusaItems)) return []
  return medusaItems.map((i) => ({
    productId: i.product_id ?? "",
    variantId: i.variant_id ?? "",
    title: i.title ?? "",
    quantity: i.quantity ?? 1,
    priceInCentavos: pricesInCentavos
      ? (i.unit_price ?? 0)
      : Math.round((i.unit_price ?? 0) * 100),
  }))
}

/**
 * Convert a Medusa order (admin API shape) to CreateOrderProjectionInput.
 * Expects prices in reais (Medusa default) — converts to centavos internally.
 * Pass `pricesInCentavos: true` if prices are already converted.
 */
export function toOrderProjectionData(
  order: MedusaOrderExpanded,
  opts?: { customerId?: string | null; pricesInCentavos?: boolean },
): CreateOrderProjectionInput {
  const pricesInCentavos = opts?.pricesInCentavos ?? false
  const toC = (v: number) => pricesInCentavos ? v : Math.round(v * 100)

  const items = toOrderEventItems(order.items, pricesInCentavos)

  return {
    id: order.id,
    displayId: order.display_id ?? 0,
    customerId: opts?.customerId ?? order.metadata?.["customerId"] ?? order.customer?.id ?? null,
    customerEmail: order.email ?? order.customer?.email ?? null,
    customerName: buildCustomerName(order.customer),
    customerPhone: order.customer?.phone ?? null,
    fulfillmentStatus: order.fulfillment_status ?? "pending",
    paymentStatus: order.payment_status ?? null,
    totalInCentavos: toC(order.total ?? 0),
    subtotalInCentavos: toC(order.subtotal ?? 0),
    shippingInCentavos: toC(order.shipping_total ?? 0),
    itemCount: items.length,
    itemsJson: items,
    itemsSchemaVersion: ITEMS_SCHEMA_VERSION,
    shippingAddressJson: order.shipping_address ?? null,
    deliveryType: order.metadata?.["deliveryType"] ?? null,
    paymentMethod: order.metadata?.["paymentMethod"] ?? null,
    tipInCentavos: Number(order.metadata?.["tipInCentavos"]) || 0,
    medusaCreatedAt: order.created_at ? new Date(order.created_at) : new Date(),
  }
}

/**
 * Validate that stored itemsJson matches the current schema version.
 * Throws if version is unsupported — prevents silent UI breakage.
 */
export function validateItemsSchema(items: unknown, version: number): OrderEventItem[] {
  if (version !== ITEMS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported order items schema version: ${version} (expected ${ITEMS_SCHEMA_VERSION})`,
    )
  }
  if (!Array.isArray(items)) return []
  return items as OrderEventItem[]
}
