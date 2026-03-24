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

export function useAdminOrdersPage() {
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')

  const filters = useMemo(() => ({
    status: statusFilter || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  }), [page, statusFilter])

  const { data: orders, count, loading, error } = useAdminOrders(filters)
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE))

  function onStatusFilter(status: string) {
    setStatusFilter(status)
    setPage(1)
  }

  return { orders, loading, error, page, totalPages, statusFilter, onStatusFilter, onPageChange: setPage }
}

// ── Reservations ────────────────────────────────────────────────────────────

export function useAdminReservationsPage() {
  const [reservations, setReservations] = useState<AdminReservation[]>([])
  const [loading, setLoading] = useState(true)
  const [dateFilter, setDateFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

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

  return {
    reservations,
    loading,
    dateFilter,
    statusFilter,
    setDateFilter,
    setStatusFilter,
    checkin,
    complete,
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
