'use client'

import { useEffect, useState } from 'react'
import type { AdminDashboardMetrics, AdminProductDetail, AdminProductRow, OrderSummary, MedusaOrderRaw } from '@ibatexas/types'
import { mapMedusaOrderToSummary } from '@ibatexas/types'
import type { Fetcher, AdminHookResult, AdminListResult, CreateAdminHookOptions, FilterableOptions } from './admin-factory'

// ── Shared filter types ────────────────────────────────────────────────────

export interface AdminProductsFilters {
  q?: string
  productType?: 'food' | 'frozen' | 'merchandise'
  limit?: number
  offset?: number
}

export interface AdminOrdersFilters {
  status?: string
  payment_status?: string
  fulfillment_status?: string
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

// ── Build all admin hooks from injected factory + fetcher ──────────────────

type CreateAdminHookFn = {
  <T>(endpoint: string): () => AdminHookResult<T | null>
  <T, TRaw>(endpoint: string, options: CreateAdminHookOptions<TRaw, T>): () => AdminHookResult<T | null>
}

type CreateAdminListHookFn = <TFilters, TRaw, T>(
  baseEndpoint: string,
  options: FilterableOptions<TFilters, TRaw, T>,
) => (filters: TFilters) => AdminListResult<T>

export function buildAdminHooks(
  createAdminHook: CreateAdminHookFn,
  createAdminListHook: CreateAdminListHookFn,
  fetcher: Fetcher,
) {
  // ── Dashboard ──────────────────────────────────────────────────────────
  const useAdminDashboard = createAdminHook<AdminDashboardMetrics>(
    '/api/admin/dashboard',
  )

  // ── Products list ──────────────────────────────────────────────────────
  const useAdminProducts = createAdminListHook<
    AdminProductsFilters,
    { products: AdminProductRow[]; count: number },
    AdminProductRow[]
  >('/api/admin/products', {
    buildParams: (filters) => {
      const params = new URLSearchParams()
      if (filters.q) params.set('q', filters.q)
      if (filters.productType) params.set('productType', filters.productType)
      if (filters.limit) params.set('limit', String(filters.limit))
      if (filters.offset) params.set('offset', String(filters.offset))
      return params
    },
    select: (res) => ({ data: res.products, count: res.count }),
    initialData: [],
  })

  // ── Single product detail (dynamic ID — manual hook) ───────────────────
  function useAdminProduct(id: string | null) {
    const [data, setData] = useState<AdminProductDetail | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<Error | null>(null)

    useEffect(() => {
      if (!id) { setData(null); setError(null); return }
      setLoading(true)
      setError(null)
      fetcher<{ product: AdminProductDetail }>(`/api/admin/products/${encodeURIComponent(id)}`)
        .then((res) => setData(res.product))
        .catch(setError)
        .finally(() => setLoading(false))
    }, [id])

    return { data, loading, error }
  }

  // ── Orders ──────────────────────────────────────────────────────────────
  const useAdminOrders = createAdminListHook<
    AdminOrdersFilters,
    { orders: MedusaOrderRaw[]; count: number },
    OrderSummary[]
  >('/api/admin/orders', {
    buildParams: (filters) => {
      const params = new URLSearchParams()
      if (filters.status) params.set('fulfillment_status', filters.status)
      if (filters.payment_status) params.set('payment_status', filters.payment_status)
      if (filters.fulfillment_status) params.set('fulfillment_status', filters.fulfillment_status)
      if (filters.date_from) params.set('date_from', filters.date_from)
      if (filters.date_to) params.set('date_to', filters.date_to)
      params.set('limit', String(filters.limit ?? 20))
      params.set('offset', String(filters.offset ?? 0))
      return params
    },
    select: (res) => ({
      data: res.orders.map((o) => {
        const summary = mapMedusaOrderToSummary(o)
        // Prefer currentPayment.status over legacy payment_status
        const cp = (o as unknown as Record<string, unknown>).currentPayment as { status?: string } | null | undefined
        if (cp?.status) summary.paymentStatus = cp.status
        return summary
      }),
      count: res.count,
    }),
    initialData: [],
  })

  return { useAdminDashboard, useAdminProducts, useAdminProduct, useAdminOrders }
}
