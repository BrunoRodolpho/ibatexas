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
