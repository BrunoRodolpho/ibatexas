// Admin domain types

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
  status: 'published' | 'draft'
  productType: 'food' | 'frozen' | 'merchandise'
  variantCount: number
  inStock: boolean
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
