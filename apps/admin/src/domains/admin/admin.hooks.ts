"use client"

import { useCallback, useEffect, useState, useMemo } from 'react'
import { apiFetch } from "@/lib/api"
import { createAdminHook, createAdminListHook } from './admin.factory'
import { buildAdminHooks } from '@ibatexas/ui'
import type { AdminReservation, AdminReview } from '@ibatexas/ui'

const hooks = buildAdminHooks(createAdminHook, createAdminListHook, apiFetch)

export const useAdminDashboard = hooks.useAdminDashboard
export const useAdminProducts = hooks.useAdminProducts
export const useAdminProduct = hooks.useAdminProduct
export const useAdminOrders = hooks.useAdminOrders

const PAGE_SIZE = 20

/** Compute ISO date_from/date_to for a given date-range preset. */
function computeDateRange(preset: string): { date_from?: string; date_to?: string } {
  if (!preset) return {}
  const now = new Date()
  const startOfDay = (d: Date) => { const r = new Date(d); r.setHours(0, 0, 0, 0); return r }
  const endOfDay = (d: Date) => { const r = new Date(d); r.setHours(23, 59, 59, 999); return r }

  switch (preset) {
    case 'hoje': {
      return { date_from: startOfDay(now).toISOString(), date_to: endOfDay(now).toISOString() }
    }
    case 'semana': {
      const day = now.getDay()
      const mon = new Date(now)
      mon.setDate(now.getDate() - ((day + 6) % 7))
      const sun = new Date(mon)
      sun.setDate(mon.getDate() + 6)
      return { date_from: startOfDay(mon).toISOString(), date_to: endOfDay(sun).toISOString() }
    }
    case 'fds': {
      const day = now.getDay()
      const sat = new Date(now)
      // If today is Sun(0), go back 1 day. If Mon-Fri, go forward to next Sat. If Sat, use today.
      if (day === 0) sat.setDate(now.getDate() - 1)
      else if (day === 6) { /* already Saturday */ }
      else sat.setDate(now.getDate() + (6 - day))
      const sun = new Date(sat)
      sun.setDate(sat.getDate() + 1)
      return { date_from: startOfDay(sat).toISOString(), date_to: endOfDay(sun).toISOString() }
    }
    case 'mes': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1)
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      return { date_from: startOfDay(first).toISOString(), date_to: endOfDay(last).toISOString() }
    }
    default:
      return {}
  }
}

export function useAdminOrdersPage() {
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [dateFilter, setDateFilter] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  const dateRange = useMemo(() => computeDateRange(dateFilter), [dateFilter])

  const filters = useMemo(() => ({
    status: statusFilter || undefined,
    date_from: dateRange.date_from,
    date_to: dateRange.date_to,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    _refresh: refreshKey,
  }), [page, statusFilter, dateRange, refreshKey])

  const { data: orders, count, loading, error } = useAdminOrders(filters)
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE))

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), [])

  function onStatusFilter(status: string) {
    setStatusFilter(status)
    setPage(1)
  }

  function onDateFilter(preset: string) {
    setDateFilter(preset)
    setPage(1)
  }

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(refetch, 30_000)
    return () => clearInterval(interval)
  }, [refetch])

  return { orders, loading, error, page, totalPages, statusFilter, dateFilter, onStatusFilter, onDateFilter, onPageChange: setPage, refetch }
}

// ── Order status update ────────────────────────────────────────────────────

export function useUpdateOrderStatus(onDone?: () => void) {
  const [updating, setUpdating] = useState(false)

  const updateStatus = useCallback(async (orderId: string, fulfillmentStatus: string, version?: number) => {
    setUpdating(true)
    try {
      const body: Record<string, unknown> = { fulfillment_status: fulfillmentStatus }
      if (version !== undefined) body.version = version
      const response = await fetch(`/api/proxy/api/admin/orders/${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        if (response.status === 409) {
          throw new Error('Pedido atualizado por outro atendente. Atualize a pagina.')
        }
        if (response.status === 422) {
          throw new Error('Transicao de status invalida.')
        }
        let message = 'Erro ao atualizar status'
        try {
          const json = await response.json() as { message?: string }
          if (json.message) message = json.message
        } catch {
          // ignore parse errors
        }
        throw new Error(message)
      }
      onDone?.()
    } finally {
      setUpdating(false)
    }
  }, [onDone])

  return { updateStatus, updating }
}

// ── Order status transition (encapsulated hook) ────────────────────────────

interface OrderForTransition {
  id: string
  fulfillment_status?: string
  fulfillmentStatus?: string
  version?: number
}

/**
 * Encapsulates version threading and status transition logic.
 * Use this instead of manually threading version through UI components.
 */
export function useOrderStatusTransition(
  order: OrderForTransition | null | undefined,
  onDone?: () => void,
) {
  const { updateStatus, updating } = useUpdateOrderStatus(onDone)
  const { getNextStatus } = require('@ibatexas/types') as typeof import('@ibatexas/types')

  const status = order?.fulfillment_status ?? order?.fulfillmentStatus ?? ''
  const nextStatus = status ? getNextStatus(status as import('@ibatexas/types').OrderFulfillmentStatus) : null

  const advance = useCallback(async () => {
    if (!order || !nextStatus) return
    await updateStatus(order.id, nextStatus, order.version)
  }, [order, nextStatus, updateStatus])

  return {
    advance,
    canAdvance: !!nextStatus,
    nextStatus,
    isLoading: updating,
    currentStatus: status,
    version: order?.version,
  }
}

// ── Order detail ───────────────────────────────────────────────────────────

export function useAdminOrderDetail(orderId: string | null) {
  const [order, setOrder] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when orderId clears
    if (!orderId) { setOrder(null); setError(null); return }
    setLoading(true)
    setError(null)
    apiFetch(`/api/admin/orders/${encodeURIComponent(orderId)}`)
      .then((res: { order?: Record<string, unknown> }) => setOrder(res.order ?? null))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [orderId, refreshKey])

  return { order, loading, error, refetch }
}

// ── Reservations ────────────────────────────────────────────────────────────

/** Compute ISO date string for a given date-range preset. */
function computeReservationDateRange(preset: string): string {
  if (!preset) return ''
  const now = new Date()
  const fmt = (d: Date) => d.toISOString().split('T')[0]!

  switch (preset) {
    case 'hoje':
      return fmt(now)
    case 'semana': {
      // Return today — the API filters by single date, so for week view we clear the date filter
      // and let all dates show. For now, map "semana" to today's date.
      return fmt(now)
    }
    case 'fds': {
      const day = now.getDay()
      const sat = new Date(now)
      if (day === 0) sat.setDate(now.getDate() - 1)
      else if (day === 6) { /* already Saturday */ }
      else sat.setDate(now.getDate() + (6 - day))
      return fmt(sat)
    }
    case 'mes':
      return '' // Show all for the month
    default:
      return ''
  }
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0]!
}

export function useAdminReservationsPage() {
  const [reservations, setReservations] = useState<AdminReservation[]>([])
  const [loading, setLoading] = useState(true)
  const [datePreset, setDatePreset] = useState('hoje')
  const [dateFilter, setDateFilter] = useState(todayISO)
  const [statusFilter, setStatusFilter] = useState('')

  const handleDatePreset = useCallback((preset: string) => {
    setDatePreset(preset)
    setDateFilter(computeReservationDateRange(preset))
  }, [])

  const handleDateFilter = useCallback((date: string) => {
    setDatePreset('') // Clear preset when manually selecting date
    setDateFilter(date)
  }, [])

  const fetchReservations = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (dateFilter) params.set('date', dateFilter)
      if (statusFilter) params.set('status', statusFilter)
      const qs = params.toString()
      const url = `/api/admin/reservations${qs ? `?${qs}` : ''}`
      const data = await apiFetch(url)
      setReservations(data.reservations ?? [])
    } catch {
      setReservations([])
    } finally {
      setLoading(false)
    }
  }, [dateFilter, statusFilter])

  useEffect(() => { fetchReservations() }, [fetchReservations])

  const checkin = useCallback(async (id: string) => {
    await apiFetch(`/api/admin/reservations/${encodeURIComponent(id)}/checkin`, { method: 'POST' })
    await fetchReservations()
  }, [fetchReservations])

  const complete = useCallback(async (id: string) => {
    await apiFetch(`/api/admin/reservations/${encodeURIComponent(id)}/complete`, { method: 'POST' })
    await fetchReservations()
  }, [fetchReservations])

  const cancel = useCallback(async (id: string) => {
    await apiFetch(`/api/admin/reservations/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
    await fetchReservations()
  }, [fetchReservations])

  return {
    reservations,
    loading,
    dateFilter,
    datePreset,
    statusFilter,
    setDateFilter: handleDateFilter,
    setDatePreset: handleDatePreset,
    setStatusFilter,
    checkin,
    complete,
    cancel,
  }
}

// ── Reviews ─────────────────────────────────────────────────────────────────

export function useAdminReviews() {
  const [reviews, setReviews] = useState<AdminReview[]>([])
  const [loading, setLoading] = useState(true)
  const [ratingFilter, setRatingFilter] = useState('')

  const fetchReviews = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (ratingFilter) params.set('rating', ratingFilter)
      const qs = params.toString()
      const url = `/api/admin/reviews${qs ? `?${qs}` : ''}`
      const data = await apiFetch(url)
      setReviews(data.reviews ?? [])
    } catch {
      setReviews([])
    } finally {
      setLoading(false)
    }
  }, [ratingFilter])

  useEffect(() => { fetchReviews() }, [fetchReviews])

  return { reviews, loading, ratingFilter, setRatingFilter }
}

// ── Analytics ──────────────────────────────────────────────────────────────

export interface AnalyticsSummary {
  ordersToday: number
  revenueToday: number
  aov: number
  activeCarts: number
  newCustomers30d: number
  outreachWeekly: number
  waConversionRate: number
  avgMessagesToCheckout: number
}

export function useAdminAnalytics() {
  const [metrics, setMetrics] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch('/api/admin/analytics/summary')
      .then((data: AnalyticsSummary) => setMetrics(data))
      .catch(() => setMetrics(null))
      .finally(() => setLoading(false))
  }, [])

  return { metrics, loading }
}
