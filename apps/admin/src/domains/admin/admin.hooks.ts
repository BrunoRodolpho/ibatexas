"use client"

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { apiFetch } from "@/lib/api"
import { createAdminHook, createAdminListHook } from './admin.factory'
import {
  buildAdminHooks,
  useToast,
  INCIDENT_TOASTS,
  INCIDENT_CAUSE_LABELS,
} from '@ibatexas/ui'
import type { AdminReservation, AdminReview, AdminIncident } from '@ibatexas/ui'

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
      const query = qs ? `?${qs}` : ''
      const url = `/api/admin/reservations${query}`
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
      const query = qs ? `?${qs}` : ''
      const url = `/api/admin/reviews${query}`
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

// ── Open incident count (sidebar badge) ──────────────────────────────────────

/**
 * Cheap 30s poll of the independent open-incident count that backs the
 * persistent sidebar badge. Degrades to 0 (no pill) on any failure so the nav
 * never breaks.
 */
export function useOpenIncidentCount(): number {
  const [openCount, setOpenCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchCount = async () => {
      try {
        const data = await apiFetch('/api/admin/incidents?status=OPEN&limit=1')
        if (!cancelled) setOpenCount(typeof data?.openCount === 'number' ? data.openCount : 0)
      } catch {
        if (!cancelled) setOpenCount(0)
      }
    }
    fetchCount()
    const interval = setInterval(fetchCount, 30_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  return openCount
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

// ── Incidentes (no-reply incident inbox) ─────────────────────────────────────

/**
 * New-OPEN-ids per single poll above which we treat the wave as a STORM and
 * suppress the per-incident beep/toast (one blip + one storm toast instead).
 * Distinct from the StormDigestBanner headline, which keys off the rolling
 * open-count window (§2 — "two distinct jobs, do not conflate").
 */
export const STORM_THRESHOLD = 5
/** Rolling open-count window length (minutes) phrased in the storm copy. */
export const STORM_WINDOW_MINUTES = 8
/** Route max page size — the active OPEN/ACK queue is fetched UNPAGINATED (F1). */
const INCIDENT_FETCH_LIMIT = 100
const INCIDENT_POLL_MS = 30_000
const INCIDENT_HISTORY_PAGE_SIZE = 20
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['AUTO_RESOLVED', 'RESOLVED'])

interface IncidentListResponse {
  readonly incidents: AdminIncident[]
  readonly openCount: number
}

export interface IncidentStats {
  readonly open: number
  readonly acknowledged: number
  readonly resolvedToday: number
  readonly resolvedAuto: number
  readonly resolvedStaff: number
  readonly avgMinutes: number
}

function startOfToday(now: Date = new Date()): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

function computeIncidentStats(rows: readonly AdminIncident[], openCount: number): IncidentStats {
  const today = startOfToday()
  const acknowledged = rows.filter((r) => r.status === 'ACKNOWLEDGED').length
  const resolvedToday = rows.filter(
    (r) => r.resolvedAt != null && new Date(r.resolvedAt) >= today,
  )
  const resolvedAuto = resolvedToday.filter((r) => r.resolutionType === 'AUTO').length
  const resolvedStaff = resolvedToday.length - resolvedAuto
  const durations = resolvedToday
    .filter((r) => r.resolvedAt != null)
    .map((r) => new Date(r.resolvedAt as string).getTime() - new Date(r.openedAt).getTime())
    .filter((ms) => ms >= 0)
  const avgMinutes = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60_000)
    : 0
  return { open: openCount, acknowledged, resolvedToday: resolvedToday.length, resolvedAuto, resolvedStaff, avgMinutes }
}

/** Most common cause across the currently-OPEN incidents (drives the storm copy). */
function dominantOpenCause(rows: readonly AdminIncident[]): string {
  const tally = new Map<string, number>()
  for (const r of rows) {
    if (r.status !== 'OPEN') continue
    tally.set(r.cause, (tally.get(r.cause) ?? 0) + 1)
  }
  let best = ''
  let bestN = 0
  for (const [cause, n] of tally) {
    if (n > bestN) { best = cause; bestN = n }
  }
  return best
}

/**
 * Backs the full two-pane Incidentes inbox. ONE fetch per 30s poll of the
 * recent set (limit=100, route max) which the API pre-sorts by composite key
 * (status-bucket → aged-first → severity desc). F1: the actionable OPEN/ACK
 * queue is therefore GLOBALLY sorted and never split across pages; pagination
 * (client-side, in the DataTable) applies ONLY to the Resolvidos/history view.
 * Status/cause/severity filtering happens client-side on the severity-refreshed
 * rows so it agrees with the read-time-derived severity the API returns.
 */
export function useAdminIncidentsPage() {
  const [allIncidents, setAllIncidents] = useState<AdminIncident[]>([])
  const [openCount, setOpenCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusFilter, setStatusFilter] = useState('') // '' | OPEN | ACKNOWLEDGED | RESOLVED
  const [causeFilter, setCauseFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch effect; loading flag drives the skeleton
    setLoading(true)
    apiFetch(`/api/admin/incidents?limit=${INCIDENT_FETCH_LIMIT}`)
      .then((data: IncidentListResponse) => {
        if (cancelled) return
        setAllIncidents(Array.isArray(data?.incidents) ? data.incidents : [])
        setOpenCount(typeof data?.openCount === 'number' ? data.openCount : 0)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Do NOT clear existing rows on a transient poll failure; surface the
        // error so the page can toast (we never silently swallow — escalações bug).
        setError(err instanceof Error ? err.message : 'load_failed')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshKey])

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Canonical 30s poll.
  useEffect(() => {
    const interval = setInterval(refetch, INCIDENT_POLL_MS)
    return () => clearInterval(interval)
  }, [refetch])

  const isHistoryView = statusFilter === 'RESOLVED'

  const incidents = useMemo(
    () =>
      allIncidents.filter((inc) => {
        if (statusFilter === '') {
          if (TERMINAL_STATUSES.has(inc.status)) return false // default view hides resolved (§5)
        } else if (statusFilter === 'RESOLVED') {
          if (!TERMINAL_STATUSES.has(inc.status)) return false // history = AUTO_RESOLVED + RESOLVED
        } else if (inc.status !== statusFilter) {
          return false
        }
        if (causeFilter && inc.cause !== causeFilter) return false
        if (severityFilter && inc.severity !== severityFilter) return false
        return true
      }),
    [allIncidents, statusFilter, causeFilter, severityFilter],
  )

  const counts = useMemo(() => {
    const active = allIncidents.filter((i) => !TERMINAL_STATUSES.has(i.status))
    return {
      open: openCount, // authoritative independent count (may exceed the fetched window)
      acknowledged: allIncidents.filter((i) => i.status === 'ACKNOWLEDGED').length,
      high: active.filter((i) => i.severity === 'high').length,
      medium: active.filter((i) => i.severity === 'medium').length,
      low: active.filter((i) => i.severity === 'low').length,
    }
  }, [allIncidents, openCount])

  const stats = useMemo(() => computeIncidentStats(allIncidents, openCount), [allIncidents, openCount])
  const dominantCause = useMemo(() => dominantOpenCause(allIncidents), [allIncidents])

  const hasActiveFilters = statusFilter !== '' || causeFilter !== '' || severityFilter !== ''
  const onClearFilters = useCallback(() => {
    setStatusFilter('')
    setCauseFilter('')
    setSeverityFilter('')
  }, [])

  return {
    incidents,
    openCount,
    loading,
    error,
    statusFilter,
    causeFilter,
    severityFilter,
    counts,
    stats,
    dominantCause,
    isHistoryView,
    hasActiveFilters,
    historyPageSize: INCIDENT_HISTORY_PAGE_SIZE,
    onStatusFilter: setStatusFilter,
    onCauseFilter: setCauseFilter,
    onSeverityFilter: setSeverityFilter,
    onClearFilters,
    refetch,
  }
}

/** Gesture-gated 800Hz blip — verbatim shape of pedidos/page.tsx:47-64. */
function playIncidentBeep(enabled: boolean): void {
  if (!enabled) return
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 800
    gain.gain.value = 0.3
    osc.start()
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
    osc.stop(ctx.currentTime + 0.3)
  } catch {
    // Audio not available
  }
}

/**
 * Mounted ONCE at the admin layout (never per-page) so the new-incident beep +
 * toast fire wherever the manager is, and so the inbox page does NOT run its own
 * diff and double-fire. Diffs an ID-SET (`prevOpenIds`) — fires on
 * `newOpenIds = openIds \ prevOpenIds` — NOT the fragile count-delta the orders
 * beep uses (which misfires across pagination/filters). Per-poll storm
 * suppression when `newOpenIds.size >= STORM_THRESHOLD` (one blip + one storm
 * toast). The first poll seeds `prevOpenIds` silently (no beep for pre-existing).
 */
export function useIncidentNewDetector(): void {
  const { addToast } = useToast()
  const prevOpenIdsRef = useRef<Set<string> | null>(null)
  const hasInteractedRef = useRef(false)

  // Gesture gate (verbatim pedidos/page.tsx:40-44) — unlock audio on first click.
  useEffect(() => {
    function markInteracted() { hasInteractedRef.current = true }
    document.addEventListener('click', markInteracted, { once: true })
    return () => document.removeEventListener('click', markInteracted)
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const data: IncidentListResponse = await apiFetch(
          `/api/admin/incidents?status=OPEN&limit=${INCIDENT_FETCH_LIMIT}`,
        )
        if (cancelled) return
        const rows = Array.isArray(data?.incidents) ? data.incidents : []
        const ids = rows.map((r) => r.id)
        const current = new Set(ids)
        const prev = prevOpenIdsRef.current
        prevOpenIdsRef.current = current
        if (prev === null) return // seed only — never beep for pre-existing incidents
        const newOpenIds = ids.filter((id) => !prev.has(id))
        if (newOpenIds.length === 0) return

        if (newOpenIds.length >= STORM_THRESHOLD) {
          playIncidentBeep(hasInteractedRef.current)
          const causeLabel = INCIDENT_CAUSE_LABELS[dominantOpenCause(rows)] ?? '—'
          addToast({
            type: 'error',
            title: INCIDENT_TOASTS.stormTitle,
            message: INCIDENT_TOASTS.stormBody(current.size, STORM_WINDOW_MINUTES, causeLabel),
            dedupeKey: 'incident-storm',
            duration: 0,
          })
        } else {
          playIncidentBeep(hasInteractedRef.current)
          addToast({
            type: 'warning',
            title: INCIDENT_TOASTS.newTitle,
            message: INCIDENT_TOASTS.newBody,
            dedupeKey: 'incident-new',
          })
        }
      } catch {
        // Swallow detector poll errors — the badge/nav must never break; the
        // inbox page surfaces its own load errors.
      }
    }
    void poll()
    const interval = setInterval(poll, INCIDENT_POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [addToast])
}
