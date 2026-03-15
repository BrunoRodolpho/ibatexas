"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api"
import type { AdminDashboardMetrics, AdminProductDetail, AdminProductRow, OrderSummary } from "@ibatexas/types"
import { mapMedusaOrderToSummary, type MedusaOrderRaw } from './admin.mappers'

// ── Dashboard ────────────────────────────────────────────────────────────────

export function useAdminDashboard() {
  const [data, setData] = useState<AdminDashboardMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    setLoading(true)
    apiFetch("/api/admin/dashboard")
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  return { data, loading, error }
}

// ── Products ─────────────────────────────────────────────────────────────────

interface AdminProductsFilters {
  q?: string
  productType?: "food" | "frozen" | "merchandise"
  limit?: number
  offset?: number
}

export function useAdminProducts(filters: AdminProductsFilters = {}) {
  const [data, setData] = useState<AdminProductRow[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const deps = JSON.stringify(filters)

  useEffect(() => {
    const params = new URLSearchParams()
    if (filters.q) params.set("q", filters.q)
    if (filters.productType) params.set("productType", filters.productType)
    if (filters.limit) params.set("limit", String(filters.limit))
    if (filters.offset) params.set("offset", String(filters.offset))

    setLoading(true)
    apiFetch(`/api/admin/products?${params}`)
      .then((res: { products: AdminProductRow[]; count: number }) => {
        setData(res.products)
        setCount(res.count)
      })
      .catch(setError)
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps])

  return { data, count, loading, error }
}

// ── Single product detail ────────────────────────────────────────────────────

export function useAdminProduct(id: string | null) {
  const [data, setData] = useState<AdminProductDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!id) { setData(null); return }
    setLoading(true)
    setError(null)
    apiFetch(`/api/admin/products/${id}`)
      .then((res: { product: AdminProductDetail }) => setData(res.product))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [id])

  return { data, loading, error }
}

// ── Orders ───────────────────────────────────────────────────────────────────

interface AdminOrdersFilters {
  status?: string
  payment_status?: string
  fulfillment_status?: string
  limit?: number
  offset?: number
}

export function useAdminOrders(filters: AdminOrdersFilters = {}) {
  const [data, setData] = useState<OrderSummary[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const deps = JSON.stringify(filters)

  useEffect(() => {
    const params = new URLSearchParams()
    if (filters.status) params.set("status", filters.status)
    if (filters.payment_status) params.set("payment_status", filters.payment_status)
    if (filters.fulfillment_status) params.set("fulfillment_status", filters.fulfillment_status)
    params.set("limit", String(filters.limit ?? 20))
    params.set("offset", String(filters.offset ?? 0))

    setLoading(true)
    apiFetch(`/api/admin/orders?${params}`)
      .then((res: { orders: MedusaOrderRaw[]; count: number }) => {
        setData(res.orders.map(mapMedusaOrderToSummary))
        setCount(res.count)
      })
      .catch(setError)
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps])

  return { data, count, loading, error }
}
