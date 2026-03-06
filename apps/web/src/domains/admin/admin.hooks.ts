"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api"
import type { AdminDashboardMetrics, AdminProductDetail, AdminProductRow, OrderSummary } from "@ibatexas/types"
import { createAdminHook, createAdminListHook } from './admin.factory'
import { mapMedusaOrderToSummary, type MedusaOrderRaw } from './admin.mappers'

// ── Dashboard (factory one-liner) ────────────────────────────────────────────

export const useAdminDashboard = createAdminHook<AdminDashboardMetrics>(
  '/api/admin/dashboard',
)

// ── Products list (factory one-liner) ────────────────────────────────────────

interface AdminProductsFilters {
  q?: string
  productType?: "food" | "frozen" | "merchandise"
  limit?: number
  offset?: number
}

export const useAdminProducts = createAdminListHook<
  AdminProductsFilters,
  { products: AdminProductRow[]; count: number },
  AdminProductRow[]
>('/api/admin/products', {
  buildParams: (filters) => {
    const params = new URLSearchParams()
    if (filters.q) params.set("q", filters.q)
    if (filters.productType) params.set("productType", filters.productType)
    if (filters.limit) params.set("limit", String(filters.limit))
    if (filters.offset) params.set("offset", String(filters.offset))
    return params
  },
  select: (res) => ({ data: res.products, count: res.count }),
  initialData: [],
})

// ── Single product detail (needs dynamic ID — kept manual) ───────────────────

export function useAdminProduct(id: string | null) {
  const [data, setData] = useState<AdminProductDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!id) { setData(null); setError(null); return }
    setLoading(true)
    setError(null)
    apiFetch(`/api/admin/products/${encodeURIComponent(id)}`)
      .then((res: { product: AdminProductDetail }) => setData(res.product))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [id])

  return { data, loading, error }
}

// ── Orders (factory one-liner) ───────────────────────────────────────────────

interface AdminOrdersFilters {
  status?: string
  payment_status?: string
  fulfillment_status?: string
  limit?: number
  offset?: number
}

export const useAdminOrders = createAdminListHook<
  AdminOrdersFilters,
  { orders: MedusaOrderRaw[]; count: number },
  OrderSummary[]
>('/api/admin/orders', {
  buildParams: (filters) => {
    const params = new URLSearchParams()
    if (filters.status) params.set("status", filters.status)
    if (filters.payment_status) params.set("payment_status", filters.payment_status)
    if (filters.fulfillment_status) params.set("fulfillment_status", filters.fulfillment_status)
    params.set("limit", String(filters.limit ?? 20))
    params.set("offset", String(filters.offset ?? 0))
    return params
  },
  select: (res) => ({ data: res.orders.map(mapMedusaOrderToSummary), count: res.count }),
  initialData: [],
})
