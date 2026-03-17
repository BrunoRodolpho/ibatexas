// Admin domain types

import type { ProductType, ProductStatus } from "./product.types.js"

export interface AdminDashboardMetrics {
  ordersToday: number
  revenueToday: number // integer centavos
  activeReservations: number
  pendingEscalations: number
  ordersTodayTrend?: number // % change vs yesterday
  revenueTodayTrend?: number
}

export interface AdminProductRow {
  id: string
  title: string
  handle: string
  imageUrl: string | null
  category: string
  price: number // integer centavos
  status: ProductStatus
  productType: ProductType
  variantCount: number
  inStock: boolean
}

export interface AdminVariant {
  id: string
  title: string // e.g. "P", "M", "G", "Único"
  sku: string | null
  price: number // integer centavos (0 if not linked)
  inventoryQuantity: number
  allowBackorder: boolean
  manageInventory: boolean
}

export interface AdminProductDetail extends AdminProductRow {
  description: string | null
  variants: AdminVariant[]
  tags: string[]
}

export interface OrderSummary {
  id: string
  displayId: number
  customerEmail: string
  customerName?: string
  itemCount: number
  total: number // integer centavos
  status: string
  paymentStatus: string
  fulfillmentStatus: string
  createdAt: string
}

// ── Raw Medusa order shape (what the API actually returns) ───────────────

export interface MedusaOrderRaw {
  id: string
  display_id?: number
  email?: string
  customer?: {
    first_name?: string
    last_name?: string
  }
  items?: unknown[]
  total?: number
  status?: string
  payment_status?: string
  fulfillment_status?: string
  created_at?: string
}

// ── Mapper ───────────────────────────────────────────────────────────────

function buildCustomerName(customer?: { first_name?: string; last_name?: string }): string | undefined {
  if (!customer) return undefined
  const full = `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim()
  return full || undefined
}

export function mapMedusaOrderToSummary(o: MedusaOrderRaw): OrderSummary {
  return {
    id: o.id,
    displayId: o.display_id ?? 0,
    customerEmail: o.email ?? '—',
    customerName: buildCustomerName(o.customer),
    itemCount: Array.isArray(o.items) ? o.items.length : 0,
    total: o.total ?? 0,
    status: o.status ?? '—',
    paymentStatus: o.payment_status ?? '—',
    fulfillmentStatus: o.fulfillment_status ?? '—',
    createdAt: o.created_at ?? '',
  }
}
