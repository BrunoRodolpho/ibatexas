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
import { sortOpsAlerts, buildOpsAlertsQuery, type OpsAlert } from './ops-alerts.mappers'
import type { OpsSnapshot } from './ops-snapshot.mappers'
import {
  canSend,
  entryFromResult,
  errorEntry,
  historyEntries,
  userEntry,
  OPS_CHAT_NETWORK_ERROR,
  type OpsChatResult,
  type OpsThreadEntry,
} from './ops-chat.mappers'
import type { AdminCustomerListResponse, AdminCustomerDetail } from './customers.mappers'
import { planOptOutToggle, optOutResultMessage } from './customers.mappers'
import {
  listPath as agentApprovalsListPath,
  planResolve as planAgentApprovalResolve,
  sortByResolvedAtDesc,
  type AgentApprovalRequest,
  type AgentApprovalStatus,
} from './agent-approvals.mappers'
import {
  AGENT_KILL_STATUS_PATH,
  killPath as agentKillPath,
  unkillPath as agentUnkillPath,
  type AgentKillStatus,
  type KillIntent,
} from './agent-killswitch.mappers'

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
  readonly stats?: IncidentStats
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

const EMPTY_STATS: IncidentStats = {
  open: 0,
  acknowledged: 0,
  resolvedToday: 0,
  resolvedAuto: 0,
  resolvedStaff: 0,
  avgMinutes: 0,
}

/**
 * Adopt the INDEPENDENT server stat aggregate (M10): `open` (OPEN-only, distinct
 * from the NON_TERMINAL sidebar openCount so the "Abertos" card never
 * double-counts "Reconhecidos"), `acknowledged`, and resolvedToday/Auto/Staff/
 * avgMinutes — all computed server-side over their own queries, NOT derived from
 * the OPEN-first limit=100 row window (which during a storm holds zero resolved
 * rows). Falls back to zeros if an older API omits `stats` so the cards never crash.
 */
function computeIncidentStats(serverStats: IncidentStats | undefined): IncidentStats {
  return serverStats ?? EMPTY_STATS
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
  const [serverStats, setServerStats] = useState<IncidentStats | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusFilter, setStatusFilter] = useState('') // '' | OPEN | ACKNOWLEDGED | RESOLVED
  const [causeFilter, setCauseFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')

  const hasLoadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    // Flash the skeleton ONLY on the initial load; the 30s poll refreshes rows in
    // place (mirrors the catch-branch intent — never disrupt existing rows on a
    // transient poll).
    if (!hasLoadedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load only; loading flag drives the skeleton
      setLoading(true)
    }
    // resolvedSince bounds the server's INDEPENDENT resolved-today aggregate to
    // local midnight (M10) so "Resolvidos hoje"/"Tempo médio" stay correct even
    // when a storm pushes all resolved rows out of the OPEN-first fetch window.
    const resolvedSince = encodeURIComponent(startOfToday().toISOString())
    apiFetch(`/api/admin/incidents?limit=${INCIDENT_FETCH_LIMIT}&resolvedSince=${resolvedSince}`)
      .then((data: IncidentListResponse) => {
        if (cancelled) return
        setAllIncidents(Array.isArray(data?.incidents) ? data.incidents : [])
        setOpenCount(typeof data?.openCount === 'number' ? data.openCount : 0)
        setServerStats(data?.stats)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Do NOT clear existing rows on a transient poll failure; surface the
        // error so the page can toast (we never silently swallow — escalações bug).
        setError(err instanceof Error ? err.message : 'load_failed')
      })
      .finally(() => { if (!cancelled) { setLoading(false); hasLoadedRef.current = true } })
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

  // Adopt the INDEPENDENT server aggregate (M10) — see computeIncidentStats.
  const stats = useMemo(() => computeIncidentStats(serverStats), [serverStats])

  const counts = useMemo(() => {
    const active = allIncidents.filter((i) => !TERMINAL_STATUSES.has(i.status))
    return {
      // OPEN-only / ACK-only server aggregates: the OPEN filter chip must NOT
      // show the NON_TERMINAL openCount (which now includes ACKNOWLEDGED), and
      // the chips must agree with the StatCards fed by the same aggregate.
      open: stats.open,
      acknowledged: stats.acknowledged,
      high: active.filter((i) => i.severity === 'high').length,
      medium: active.filter((i) => i.severity === 'medium').length,
      low: active.filter((i) => i.severity === 'low').length,
    }
  }, [allIncidents, stats])
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

// ── Alertas Operacionais (deterministic ops-watchdog inbox — BKL-082) ────────

/** Route max page size — the ops inbox is fetched UNPAGINATED (server pre-sorts). */
const OPS_ALERT_FETCH_LIMIT = 200
const OPS_ALERT_POLL_MS = 30_000

interface OpsAlertListResponse {
  readonly alerts: OpsAlert[]
  readonly openCount: number
}

/**
 * Backs the Alertas Operacionais inbox (BKL-082). ONE fetch per 30s poll of the
 * ops-alert list with the active status/cause filters passed to the API (the
 * server filters + pre-sorts OPEN-first). `openCount` is the INDEPENDENT
 * NON_TERMINAL count returned alongside the rows — it backs the badge and is
 * unaffected by the list filters. Resolve is reload-after-write (not optimistic),
 * mirroring `useAdminIncidentsPage`. Load failures are surfaced (never swallowed)
 * so the page can toast; a transient poll failure does NOT clear existing rows.
 */
export function useAdminOpsAlertsPage() {
  const [alerts, setAlerts] = useState<OpsAlert[]>([])
  const [openCount, setOpenCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [causeFilter, setCauseFilter] = useState('')

  const hasLoadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    // Flash the skeleton ONLY on the initial load; the 30s poll refreshes rows in
    // place (mirrors the incidentes catch-branch intent — never disrupt rows on a
    // transient poll).
    if (!hasLoadedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load only; loading flag drives the skeleton
      setLoading(true)
    }
    const query = buildOpsAlertsQuery({
      status: statusFilter || undefined,
      cause: causeFilter || undefined,
      limit: OPS_ALERT_FETCH_LIMIT,
    })
    apiFetch(`/api/admin/ops-alerts${query}`)
      .then((data: OpsAlertListResponse) => {
        if (cancelled) return
        setAlerts(Array.isArray(data?.alerts) ? sortOpsAlerts(data.alerts) : [])
        setOpenCount(typeof data?.openCount === 'number' ? data.openCount : 0)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Do NOT clear existing rows on a transient poll failure; surface the error.
        setError(err instanceof Error ? err.message : 'load_failed')
      })
      .finally(() => { if (!cancelled) { setLoading(false); hasLoadedRef.current = true } })
    return () => { cancelled = true }
  }, [statusFilter, causeFilter, refreshKey])

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Canonical 30s poll.
  useEffect(() => {
    const interval = setInterval(refetch, OPS_ALERT_POLL_MS)
    return () => clearInterval(interval)
  }, [refetch])

  // Reload-after-write. Throws on failure (apiFetch throws on non-ok) so the page
  // can discriminate the toast; a successful resolve triggers a refetch.
  const resolveAlert = useCallback(async (id: string) => {
    await apiFetch(`/api/admin/ops-alerts/${encodeURIComponent(id)}/resolve`, { method: 'POST' })
    setRefreshKey((k) => k + 1)
  }, [])

  const hasActiveFilters = statusFilter !== '' || causeFilter !== ''
  const onClearFilters = useCallback(() => {
    setStatusFilter('')
    setCauseFilter('')
  }, [])

  return {
    alerts,
    openCount,
    loading,
    error,
    statusFilter,
    causeFilter,
    hasActiveFilters,
    onStatusFilter: setStatusFilter,
    onCauseFilter: setCauseFilter,
    onClearFilters,
    resolveAlert,
    refetch,
  }
}

// ── Painel Operacional (read-only ops situational snapshot — NEW-041) ─────────

const OPS_SNAPSHOT_POLL_MS = 30_000

/**
 * Backs the Painel Operacional overview (NEW-041). ONE fetch per 30s poll of the
 * READ-ONLY composed GET /api/admin/ops/snapshot (NEW-040) — alertas, incidentes,
 * cozinha and caixa folded into one manager-awareness view. Mirrors
 * useAdminOpsAlertsPage: skeleton only on the initial load; a transient poll
 * failure surfaces the error (never swallowed, so the page can show an error
 * state) WITHOUT clearing the last-good snapshot; `reload` bumps the refresh key.
 */
export function useAdminOpsSnapshot() {
  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const hasLoadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    if (!hasLoadedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load only; loading flag drives the skeleton
      setLoading(true)
    }
    apiFetch('/api/admin/ops/snapshot')
      .then((data: OpsSnapshot) => {
        if (cancelled) return
        setSnapshot(data)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Do NOT clear the last-good snapshot on a transient poll failure; surface
        // the error so the page can render its error state / toast.
        setError(err instanceof Error ? err.message : 'load_failed')
      })
      .finally(() => { if (!cancelled) { setLoading(false); hasLoadedRef.current = true } })
    return () => { cancelled = true }
  }, [refreshKey])

  const reload = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Canonical 30s poll.
  useEffect(() => {
    const interval = setInterval(reload, OPS_SNAPSHOT_POLL_MS)
    return () => clearInterval(interval)
  }, [reload])

  return { snapshot, loading, error, reload }
}

// ── Clientes (read-only customer management — OPS-070) ───────────────────────

const CUSTOMERS_PAGE_SIZE = 20
const CUSTOMERS_SEARCH_DEBOUNCE_MS = 300

/**
 * Backs the Clientes search list (OPS-070). Debounces the free-text query, then
 * fetches ONE page of the READ-ONLY GET /api/admin/customers[?q=&limit=&offset=]
 * search. VIEW-FIRST — no mutation. Mirrors useAdminOpsSnapshot's discipline:
 * the skeleton shows only on the initial load; a transient failure surfaces the
 * error (never swallowed) WITHOUT clearing the last-good page; changing the
 * debounced query resets to page 0.
 */
export function useAdminCustomers() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<AdminCustomerListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const hasLoadedRef = useRef(false)

  // Debounce the query; a new debounced value resets pagination to the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(query.trim())
      setPage(0)
    }, CUSTOMERS_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    let cancelled = false
    if (!hasLoadedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load only; loading flag drives the skeleton
      setLoading(true)
    }
    const params = new URLSearchParams()
    if (debouncedQuery) params.set('q', debouncedQuery)
    params.set('limit', String(CUSTOMERS_PAGE_SIZE))
    params.set('offset', String(page * CUSTOMERS_PAGE_SIZE))
    apiFetch(`/api/admin/customers?${params.toString()}`)
      .then((res: AdminCustomerListResponse) => {
        if (cancelled) return
        setData(res)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'load_failed')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          hasLoadedRef.current = true
        }
      })
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, page, refreshKey])

  const reload = useCallback(() => setRefreshKey((k) => k + 1), [])
  const totalPages = data ? Math.max(1, Math.ceil(data.count / CUSTOMERS_PAGE_SIZE)) : 1

  return {
    query,
    setQuery,
    customers: data?.customers ?? [],
    count: data?.count ?? 0,
    page,
    setPage,
    totalPages,
    pageSize: CUSTOMERS_PAGE_SIZE,
    loading,
    error,
    reload,
  }
}

/**
 * Backs the Clientes detail view (OPS-070). Fetches the composed READ-ONLY
 * GET /api/admin/customers/:id when an id is selected; a null id clears the
 * panel. A 404 (unknown id) is surfaced distinctly (`notFound`) so the page can
 * render an honest "não encontrado" state instead of a generic error toast.
 */
export function useAdminCustomer(id: string | null) {
  const [customer, setCustomer] = useState<AdminCustomerDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    // No selection → nothing to fetch. State is NOT reset here (that would be a
    // cascading set-state-in-effect); the "no selection" view is DERIVED below.
    if (!id) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load transition for the newly-selected id
    setLoading(true)
    setNotFound(false)
    setError(null)
    apiFetch(`/api/admin/customers/${encodeURIComponent(id)}`)
      .then((data: AdminCustomerDetail) => {
        if (cancelled) return
        setCustomer(data)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'load_failed'
        if (msg.includes('404')) {
          setNotFound(true)
          setCustomer(null)
        }
        setError(msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  // Derive the empty state for "no selection" so deselecting never depends on a
  // reset effect (and a stale customer never flashes when id is cleared).
  if (!id) {
    return { customer: null, loading: false, error: null, notFound: false }
  }
  return { customer, loading, error, notFound }
}

/**
 * Backs the broadcast opt-out TOGGLE on the Clientes detail (BKL-097). The only
 * governed customer-data write on this surface — it REUSES the existing
 * manager-gated opt-out/opt-in admin endpoints VERBATIM (no new mutation
 * authority), posting `{ recipient: phone }` (the same key the detail-compose
 * reads back). All transition logic is the PURE `planOptOutToggle`; this hook is
 * the optimistic/rollback wrapper around it.
 *
 * Seeded ONCE from the detail's `initialOptedOut`; the caller keys the control
 * on the customer id so a new selection re-seeds fresh (no reset effect). A click
 * to re-enable marketing (opt-in) is a re-consent decision → it opens a confirm
 * step first; stopping sends (opt-out) is direct. The badge flips optimistically
 * and rolls back on a failed write, always with an HONEST pt-BR toast — a failed
 * write NEVER reads as success. An in-flight ref makes the guard closure-stable
 * so overlapping toggles can't double-fire.
 */
export function useCustomerOptOut(phone: string, initialOptedOut: boolean) {
  const { addToast } = useToast()
  const [optedOut, setOptedOut] = useState(initialOptedOut)
  const [pending, setPending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const inFlightRef = useRef(false)

  // Perform the governed write for the CURRENT state's plan: flip optimistically,
  // POST to the reused endpoint, roll back + toast honestly on failure.
  const perform = useCallback(async () => {
    if (inFlightRef.current) return
    const plan = planOptOutToggle(optedOut)
    inFlightRef.current = true
    setPending(true)
    setOptedOut(plan.optimistic)
    try {
      await apiFetch(plan.endpoint, {
        method: 'POST',
        body: JSON.stringify({ recipient: phone }),
      })
      addToast({
        type: 'success',
        message: optOutResultMessage(plan.action, true),
        dedupeKey: 'customer-optout-toggle',
      })
    } catch {
      // Roll back the optimistic flip — the write did not land.
      setOptedOut(plan.previous)
      addToast({
        type: 'error',
        message: optOutResultMessage(plan.action, false),
        dedupeKey: 'customer-optout-toggle',
      })
    } finally {
      inFlightRef.current = false
      setPending(false)
    }
  }, [optedOut, phone, addToast])

  // A click routes through the plan: re-consent (opt-in) opens the confirm step;
  // stopping sends (opt-out) fires directly.
  const requestToggle = useCallback(() => {
    if (inFlightRef.current) return
    if (planOptOutToggle(optedOut).requiresConfirm) {
      setConfirmOpen(true)
      return
    }
    void perform()
  }, [optedOut, perform])

  const confirmToggle = useCallback(() => {
    setConfirmOpen(false)
    void perform()
  }, [perform])

  const cancelConfirm = useCallback(() => setConfirmOpen(false), [])

  return { optedOut, pending, confirmOpen, requestToggle, confirmToggle, cancelConfirm }
}

// ── Canal Operacional (ops-actor chat — BKL-087) ─────────────────────────────

const OPS_CHAT_ENDPOINT = '/api/proxy/api/admin/ops/chat'
const OPS_CHAT_HISTORY_ENDPOINT = '/api/proxy/api/admin/ops/chat/history'

/**
 * GET the caller's persisted ops thread for the initial UI hydrate (BKL-091).
 * Raw fetch (not apiFetch, which discards the body) so the `messages` array can
 * be read; `credentials: 'include'` rides the staff-JWT cookie that /api/proxy
 * forwards upstream to the requireStaff route. Throws on a non-ok status so the
 * caller treats hydrate as best-effort (a silent empty start).
 */
async function fetchOpsHistory(): Promise<unknown> {
  const res = await fetch(OPS_CHAT_HISTORY_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`ops-chat history HTTP ${res.status}`)
  return res.json()
}

/**
 * POST one ops command and return the SETTLED result WITHOUT throwing on a
 * non-ok status. Unlike `apiFetch` (which throws and discards the body), this
 * reads the response body on BOTH paths so a 403 / 502 / 503 can surface the
 * server's own pt-BR error text honestly (same reason useUpdateOrderStatus does
 * a raw fetch). `credentials: 'include'` rides the staff-JWT cookie, which the
 * /api/proxy forwards upstream to the requireStaff route.
 */
async function postOpsChat(message: string): Promise<OpsChatResult> {
  const res = await fetch(OPS_CHAT_ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // A non-JSON error body (e.g. a gateway 502) — fall through with null; the
    // error mapper then uses the status-keyed pt-BR fallback.
  }
  return { ok: res.ok, status: res.status, body }
}

let opsChatEntrySeq = 0
/** Monotonic client-only entry id (stable React key; v1 has no server id). */
function nextOpsChatId(): string {
  opsChatEntrySeq += 1
  return `ops-chat-${opsChatEntrySeq}`
}

/**
 * Backs the Canal Operacional chat (BKL-087) — the manager/owner ↔ ops-actor
 * surface over POST /api/admin/ops/chat (NEW-032 slice B). The transcript is
 * CLIENT-ONLY: v1 of the channel is STATELESS per turn (no server history), so
 * this hook holds the thread in memory and sends one independent turn at a time.
 * A failed turn appends an HONEST error bubble (the server's pt-BR text) and
 * NEVER drops the existing thread — mirroring the "never swallow" discipline of
 * useAdminOpsSnapshot. An in-flight lock (a ref, so the guard is closure-stable)
 * prevents overlapping sends while the composer is disabled.
 */
export function useOpsChat() {
  const [entries, setEntries] = useState<OpsThreadEntry[]>([])
  const [inFlight, setInFlight] = useState(false)
  const inFlightRef = useRef(false)

  // Hydrate the persisted thread once on mount (BKL-091). Best-effort: a fetch
  // failure or an empty history is a SILENT empty start (logged, never an error
  // bubble on mount). Hydrated turns are PREPENDED so they precede any live turn
  // that raced ahead, and their `ops-hist-*` ids never collide with `ops-chat-*`.
  useEffect(() => {
    let cancelled = false
    fetchOpsHistory()
      .then((body) => {
        if (cancelled) return
        const hydrated = historyEntries(body)
        if (hydrated.length === 0) return
        setEntries((prev) => [...hydrated, ...prev])
      })
      .catch((err: unknown) => {
        // Best-effort hydrate — start empty, never surface an error to the manager.
        console.error('Failed to hydrate ops-chat history (starting empty)', err)
      })
    return () => { cancelled = true }
  }, [])

  const send = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!canSend(text, inFlightRef.current)) return
    inFlightRef.current = true
    setInFlight(true)
    setEntries((prev) => [...prev, userEntry(nextOpsChatId(), text)])
    try {
      const result = await postOpsChat(text)
      setEntries((prev) => [...prev, entryFromResult(nextOpsChatId(), result)])
    } catch {
      // Transport failure (fetch rejected) — honest error bubble, never fake
      // success; the thread is preserved.
      setEntries((prev) => [...prev, errorEntry(nextOpsChatId(), OPS_CHAT_NETWORK_ERROR)])
    } finally {
      inFlightRef.current = false
      setInFlight(false)
    }
  }, [])

  return { entries, inFlight, send }
}

// ── Aprovações (managed-agent one-tap approvals inbox — AUT-024) ───────────────

const AGENT_APPROVAL_POLL_MS = 30_000

/** Distinct plane-off state: ALL agent-approval routes 404 when the managed-agent
 *  plane is disabled (IBX_AGENTS_ENABLED unset) — an honest empty/disabled state,
 *  not an error crash. */
export type AgentApprovalsListState =
  | { readonly planeOff: false; readonly approvals: AgentApprovalRequest[] }
  | { readonly planeOff: true; readonly approvals: [] }

/**
 * Tolerant raw fetch (not apiFetch, which throws away the status code) so the
 * plane-off 404 can be told apart from a real failure. Mirrors the pedidos
 * postConfirmStep raw-fetch idiom (credentials-included proxy fetch). Throws on a
 * non-404 non-OK so the caller surfaces the error (never a silent swallow).
 */
async function fetchAgentApprovals(status?: AgentApprovalStatus): Promise<AgentApprovalsListState> {
  const res = await fetch(`/api/proxy${agentApprovalsListPath(status)}`, { credentials: 'include' })
  if (res.status === 404) return { planeOff: true, approvals: [] }
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  const data = (await res.json().catch(() => ({}))) as { approvals?: AgentApprovalRequest[] }
  return { planeOff: false, approvals: Array.isArray(data.approvals) ? data.approvals : [] }
}

/**
 * Backs the pending-approvals inbox. ONE fetch per 30s poll of `?status=pending`;
 * skeleton flashes only on the initial load (the poll refreshes rows in place). A
 * transient poll failure surfaces the error WITHOUT clearing existing rows
 * (never swallowed — mirrors useAdminIncidentsPage). `planeOff` renders the honest
 * disabled state. `resolveApproval` POSTs the single-use resolve WITHOUT side
 * effects (the page owns the toast + the reload decision, honoring the mapper's
 * per-status reload intent); it returns the HTTP status + the kernel decision kind
 * so the page can report the OUTCOME honestly (a 200 can carry a non-EXECUTE
 * decision).
 */
export function useAgentApprovals() {
  const [approvals, setApprovals] = useState<AgentApprovalRequest[]>([])
  const [planeOff, setPlaneOff] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const hasLoadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    if (!hasLoadedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load only; loading flag drives the skeleton
      setLoading(true)
    }
    fetchAgentApprovals('pending')
      .then((state) => {
        if (cancelled) return
        setPlaneOff(state.planeOff)
        setApprovals(state.approvals)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Do NOT clear existing rows on a transient poll failure; surface the error.
        setError(err instanceof Error ? err.message : 'load_failed')
      })
      .finally(() => { if (!cancelled) { setLoading(false); hasLoadedRef.current = true } })
    return () => { cancelled = true }
  }, [refreshKey])

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Canonical 30s poll.
  useEffect(() => {
    const interval = setInterval(refetch, AGENT_APPROVAL_POLL_MS)
    return () => clearInterval(interval)
  }, [refetch])

  // Raw fetch (not apiFetch) so we read the exact status code AND the kernel
  // decision kind from the 200 body. No implicit refetch — the page decides.
  const resolveApproval = useCallback(
    async (token: string, accept: boolean): Promise<{ ok: boolean; status: number; decisionKind?: string }> => {
      const plan = planAgentApprovalResolve(token, accept)
      const res = await fetch(`/api/proxy${plan.path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan.body),
      })
      const data = (await res.json().catch(() => ({}))) as { decision?: { kind?: string } }
      return { ok: res.ok, status: res.status, decisionKind: data.decision?.kind }
    },
    [],
  )

  return { approvals, planeOff, loading, error, resolveApproval, refetch }
}

/**
 * Backs the toggleable resolved-history section. Lazy: fetches ONLY while
 * `enabled` (the section is open). Merges `?status=approved` + `?status=rejected`
 * and orders most-recently-resolved first. No poll (history is not time-critical);
 * `refetch` reloads after a resolve settles.
 */
export function useAgentApprovalHistory(enabled: boolean) {
  const [history, setHistory] = useState<AgentApprovalRequest[]>([])
  const [planeOff, setPlaneOff] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-open drives the skeleton
    setLoading(true)
    Promise.all([fetchAgentApprovals('approved'), fetchAgentApprovals('rejected')])
      .then(([approved, rejected]) => {
        if (cancelled) return
        if (approved.planeOff || rejected.planeOff) {
          setPlaneOff(true)
          setHistory([])
          return
        }
        setPlaneOff(false)
        setHistory(sortByResolvedAtDesc([...approved.approvals, ...rejected.approvals]))
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'load_failed')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [enabled, refreshKey])

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), [])

  return { history, planeOff, loading, error, refetch }
}

/**
 * Cheap 30s poll of the pending-approval count that backs the sidebar badge.
 * Degrades to 0 (no pill) on any failure OR when the plane is off, so the nav
 * never breaks. Mirrors useOpenIncidentCount.
 */
export function useAgentApprovalPendingCount(): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchCount = async () => {
      try {
        const state = await fetchAgentApprovals('pending')
        if (!cancelled) setCount(state.planeOff ? 0 : state.approvals.length)
      } catch {
        if (!cancelled) setCount(0)
      }
    }
    void fetchCount()
    const interval = setInterval(() => { void fetchCount() }, AGENT_APPROVAL_POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  return count
}

// ── Agentes (per-agent kill-switch control — BKL-099) ──────────────────────────

const AGENT_KILL_STATUS_POLL_MS = 30_000

/**
 * The kill-status roster read is MANAGER-gated (requireManagerRole), so unlike the
 * approvals list it distinguishes THREE non-OK terminals: the plane-off 503, the
 * non-manager 403, and a real transport failure. A tolerant raw fetch (not
 * apiFetch, which discards the status) tells them apart so the page renders the
 * honest banner for each. Throws on any other non-OK so the caller surfaces it.
 */
export type AgentKillListState =
  | { readonly kind: 'ok'; readonly agents: AgentKillStatus[] }
  | { readonly kind: 'planeOff' }
  | { readonly kind: 'forbidden' }

async function fetchAgentKillStatus(): Promise<AgentKillListState> {
  const res = await fetch(`/api/proxy${AGENT_KILL_STATUS_PATH}`, { credentials: 'include' })
  if (res.status === 503) return { kind: 'planeOff' }
  if (res.status === 403) return { kind: 'forbidden' }
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  const data = (await res.json().catch(() => ({}))) as { agents?: AgentKillStatus[] }
  return { kind: 'ok', agents: Array.isArray(data.agents) ? data.agents : [] }
}

/**
 * Backs the "Agentes" kill-switch control. ONE fetch per 30s poll of the roster +
 * kill-status; skeleton flashes only on the initial load (the poll refreshes rows
 * in place). A transient poll failure surfaces the error WITHOUT clearing existing
 * rows. `planeOff` / `forbidden` render the honest disabled banners. `toggleAgent`
 * POSTs the trip/clear WITHOUT side effects (the page owns the toast + the reload
 * decision) and returns the HTTP status + the AUTHORITATIVE written `killed` flag
 * off the 200 body, so the page reports the OUTCOME honestly (reload-after-write,
 * never optimistic — a killed:true that comes back still-live is reported, not
 * faked).
 */
export function useAgentKillSwitch() {
  const [agents, setAgents] = useState<AgentKillStatus[]>([])
  const [planeOff, setPlaneOff] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const hasLoadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    if (!hasLoadedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load only; loading flag drives the skeleton
      setLoading(true)
    }
    fetchAgentKillStatus()
      .then((state) => {
        if (cancelled) return
        setPlaneOff(state.kind === 'planeOff')
        setForbidden(state.kind === 'forbidden')
        setAgents(state.kind === 'ok' ? state.agents : [])
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Do NOT clear existing rows on a transient poll failure; surface the error.
        setError(err instanceof Error ? err.message : 'load_failed')
      })
      .finally(() => { if (!cancelled) { setLoading(false); hasLoadedRef.current = true } })
    return () => { cancelled = true }
  }, [refreshKey])

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Canonical 30s poll.
  useEffect(() => {
    const interval = setInterval(refetch, AGENT_KILL_STATUS_POLL_MS)
    return () => clearInterval(interval)
  }, [refetch])

  // Raw fetch (not apiFetch) so we read the exact status code AND the written
  // `killed` flag off the 200 body. No implicit refetch — the page decides.
  const toggleAgent = useCallback(
    async (agentId: string, intent: KillIntent): Promise<{ ok: boolean; status: number; killed?: boolean }> => {
      const path = intent === 'kill' ? agentKillPath(agentId) : agentUnkillPath(agentId)
      const res = await fetch(`/api/proxy${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = (await res.json().catch(() => ({}))) as { killed?: boolean }
      return { ok: res.ok, status: res.status, killed: data.killed }
    },
    [],
  )

  return { agents, planeOff, forbidden, loading, error, toggleAgent, refetch }
}

/**
 * Cheap 30s poll of the KILLED-agent count that backs the sidebar badge — a
 * tripped kill switch is an incident-level signal an operator wants surfaced in
 * the nav. Degrades to 0 (no pill) on any failure, when the plane is off, OR when
 * the viewer is not a manager (the roster read 403s → 0). Mirrors
 * useAgentApprovalPendingCount.
 */
export function useAgentKilledCount(): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchCount = async () => {
      try {
        const state = await fetchAgentKillStatus()
        if (cancelled) return
        setCount(state.kind === 'ok' ? state.agents.filter((a) => a.killed).length : 0)
      } catch {
        if (!cancelled) setCount(0)
      }
    }
    void fetchCount()
    const interval = setInterval(() => { void fetchCount() }, AGENT_KILL_STATUS_POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  return count
}
