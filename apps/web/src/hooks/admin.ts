"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api"
import type { AdminDashboardMetrics, AdminProductRow, OrderSummary } from "@ibatexas/types"

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
  const [data, setData] = useState<import('@ibatexas/types').AdminProductDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!id) { setData(null); return }
    setLoading(true)
    setError(null)
    apiFetch(`/api/admin/products/${id}`)
      .then((res: { product: import('@ibatexas/types').AdminProductDetail }) => setData(res.product))
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
      .then((res: { orders: Record<string, unknown>[]; count: number }) => {
        // Map Medusa order shape to OrderSummary
        const summaries: OrderSummary[] = res.orders.map((o) => ({
          id: o.id as string,
          displayId: (o.display_id as number) ?? 0,
          customerEmail: (o.email as string) ?? "—",
          customerName: (o as { customer?: { first_name?: string; last_name?: string } }).customer
            ? `${(o as { customer?: { first_name?: string } }).customer?.first_name ?? ""} ${(o as { customer?: { last_name?: string } }).customer?.last_name ?? ""}`.trim()
            : undefined,
          itemCount: Array.isArray(o.items) ? (o.items as unknown[]).length : 0,
          total: (o.total as number) ?? 0,
          status: (o.status as string) ?? "—",
          paymentStatus: (o.payment_status as string) ?? "—",
          fulfillmentStatus: (o.fulfillment_status as string) ?? "—",
          createdAt: (o.created_at as string) ?? "",
        }))
        setData(summaries)
        setCount(res.count)
      })
      .catch(setError)
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps])

  return { data, count, loading, error }
}
