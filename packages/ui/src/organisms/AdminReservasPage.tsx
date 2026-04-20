'use client'

import { useState } from 'react'
import { CalendarDays, Users, Clock, MapPin, Loader2, X } from 'lucide-react'
import { Badge } from '../atoms/Badge'
import { PageHeader } from '../atoms/PageHeader'
import { PageSkeleton } from '../atoms/PageSkeleton'
import { EmptyState } from '../atoms/EmptyState'
import { PageShell } from '../layouts/PageShell'
import { FilterBar } from '../molecules/FilterBar'
import { FilterChip } from '../molecules/FilterChip'
import {
  RESERVATION_STATUS_LABELS,
  ACTION_LABELS,
  EMPTY_STATES,
  PAGE_TITLES,
} from '../constants/admin-labels'

export interface AdminReservation {
  id: string
  displayId?: number
  customerName: string | null
  customerPhone: string | null
  partySize: number
  dateTime: string | null
  tableNumber: string | null
  status: 'pending' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show'
}

type Status = AdminReservation['status']

const STATUS_LABELS = RESERVATION_STATUS_LABELS as Record<Status, string>

const STATUS_BADGE_VARIANT: Record<Status, 'warning' | 'primary' | 'success' | 'default' | 'danger'> = {
  pending: 'warning',
  confirmed: 'primary',
  seated: 'success',
  completed: 'default',
  cancelled: 'danger',
  no_show: 'danger',
}

const STATUS_DOT: Record<Status, string> = {
  pending: 'bg-accent-amber',
  confirmed: 'bg-brand-500',
  seated: 'bg-accent-green',
  completed: 'bg-smoke-400',
  cancelled: 'bg-accent-red',
  no_show: 'bg-accent-red',
}

const DATE_PRESETS = [
  { id: '', label: 'Todas' },
  { id: 'hoje', label: 'Hoje' },
  { id: 'semana', label: 'Semana' },
  { id: 'fds', label: 'Fim de Semana' },
  { id: 'mes', label: 'Mês' },
] as const

const STATUS_OPTIONS: Array<{ id: string; label: string; dot?: string }> = [
  { id: '', label: 'Todos' },
  { id: 'pending', label: 'Pendente', dot: STATUS_DOT.pending },
  { id: 'confirmed', label: 'Confirmada', dot: STATUS_DOT.confirmed },
  { id: 'seated', label: 'Sentada', dot: STATUS_DOT.seated },
  { id: 'completed', label: 'Completa', dot: STATUS_DOT.completed },
  { id: 'cancelled', label: 'Cancelada', dot: STATUS_DOT.cancelled },
  { id: 'no_show', label: 'No Show', dot: STATUS_DOT.no_show },
]

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  } catch { return '—' }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
  } catch { return '—' }
}

function formatReservationId(displayId?: number) {
  if (!displayId) return '—'
  return `#${String(displayId).padStart(3, '0')}`
}

export interface AdminReservasPageProps {
  reservations: AdminReservation[]
  loading: boolean
  dateFilter: string
  datePreset?: string
  statusFilter: string
  onDateFilter: (date: string) => void
  onDatePreset?: (preset: string) => void
  onStatusFilter: (status: string) => void
  onCheckin: (id: string) => void | Promise<void>
  onComplete: (id: string) => void | Promise<void>
  onCancel?: (id: string) => void | Promise<void>
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

// ── Reservation Row ────────────────────────────────────────────────

function ReservationRow({
  reservation,
  onCheckin,
  onComplete,
  onCancel,
}: {
  readonly reservation: AdminReservation
  readonly onCheckin: (id: string) => void | Promise<void>
  readonly onComplete: (id: string) => void | Promise<void>
  readonly onCancel?: (id: string) => void | Promise<void>
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const { id, status, displayId, customerName, customerPhone, partySize, dateTime, tableNumber } = reservation

  async function handleAction(action: string, fn: (id: string) => void | Promise<void>) {
    setActionLoading(action)
    try { await fn(id) } finally { setActionLoading(null) }
  }

  const canCheckin = status === 'confirmed'
  const canComplete = status === 'seated'
  const canCancel = ['pending', 'confirmed', 'seated'].includes(status)
  const isTerminal = ['completed', 'cancelled', 'no_show'].includes(status)
  const hasActions = !isTerminal && (canCheckin || canComplete || canCancel)

  return (
    <div className={`flex items-center gap-3 border-b border-smoke-100 px-1 py-3 last:border-0 ${
      isTerminal ? 'opacity-50' : ''
    }`}>
      {/* Status dot */}
      <span className={`h-2 w-2 rounded-full flex-shrink-0 ${STATUS_DOT[status]}`} />

      {/* ID */}
      <span className="w-10 font-mono text-[11px] font-medium text-charcoal-500 flex-shrink-0 tabular-nums">
        {formatReservationId(displayId)}
      </span>

      {/* Customer */}
      <div className="min-w-0 flex-1">
        <span className={`text-sm truncate block ${isTerminal ? 'text-charcoal-500' : 'font-medium text-charcoal-900'}`}>
          {customerName ?? customerPhone ?? 'Cliente não identificado'}
        </span>
      </div>

      {/* Meta */}
      <div className="hidden sm:flex items-center gap-4 text-xs text-smoke-500 flex-shrink-0 tabular-nums">
        <span className="inline-flex items-center gap-1 w-8 justify-end">
          <Users className="h-3 w-3 text-smoke-400" />{partySize}
        </span>
        <span className="inline-flex items-center gap-1 w-12">
          <Clock className="h-3 w-3 text-smoke-400" />{formatTime(dateTime)}
        </span>
        <span className="inline-flex items-center gap-1 w-8">
          {tableNumber
            ? <><MapPin className="h-3 w-3 text-smoke-400" />{tableNumber}</>
            : <span className="w-full" />
          }
        </span>
      </div>

      {/* Status badge */}
      <div className="w-24 flex-shrink-0 flex justify-center">
        <Badge variant={STATUS_BADGE_VARIANT[status]}>
          {STATUS_LABELS[status]}
        </Badge>
      </div>

      {/* Actions */}
      <div className="w-44 flex-shrink-0 flex justify-end gap-1.5">
        {hasActions && (
          <>
            {canCheckin && (
              <button onClick={() => handleAction('checkin', onCheckin)} disabled={actionLoading !== null}
                className="inline-flex items-center gap-1 rounded-sm bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors">
                {actionLoading === 'checkin' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {ACTION_LABELS.checkin}
              </button>
            )}
            {canComplete && (
              <button onClick={() => handleAction('complete', onComplete)} disabled={actionLoading !== null}
                className="inline-flex items-center gap-1 rounded-sm bg-charcoal-800 px-3 py-1 text-xs font-medium text-white hover:bg-charcoal-900 disabled:opacity-50 transition-colors">
                {actionLoading === 'complete' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {ACTION_LABELS.complete}
              </button>
            )}
            {canCancel && onCancel && (
              <button onClick={() => handleAction('cancel', onCancel)} disabled={actionLoading !== null}
                className="inline-flex items-center gap-1 rounded-sm border border-accent-red/20 px-3 py-1 text-xs font-medium text-accent-red hover:bg-accent-red/5 disabled:opacity-50 transition-colors">
                {actionLoading === 'cancel' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {ACTION_LABELS.cancelReservation}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────

export function AdminReservasPage({
  reservations,
  loading,
  dateFilter,
  datePreset,
  statusFilter,
  onDateFilter,
  onDatePreset,
  onStatusFilter,
  onCheckin,
  onComplete,
  onCancel,
}: Readonly<AdminReservasPageProps>) {

  const hasActiveFilters = !!(statusFilter || datePreset)
  const total = reservations.length
  const totalGuests = reservations.reduce((sum, r) => sum + r.partySize, 0)

  // Status counts
  const statusCounts = reservations.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <PageShell>
      {/* Header */}
      <PageHeader
        icon={CalendarDays}
        title={PAGE_TITLES.reservations}
        subtitle={!loading && total > 0
          ? `${total} ${total === 1 ? 'reserva' : 'reservas'} · ${totalGuests} ${totalGuests === 1 ? 'pessoa' : 'pessoas'}`
          : undefined}
      />

      {/* ── Filter bar: date tabs + date picker + status dots ─────── */}
      <div className="space-y-2">
        {/* Row 1: Date tabs + date picker */}
        {onDatePreset && (
          <FilterBar>
            {DATE_PRESETS.map((f) => (
              <FilterChip key={f.id || 'd-all'} id={f.id} label={f.label}
                selected={(datePreset ?? '') === f.id}
                onToggle={() => onDatePreset(f.id)} />
            ))}
            <input type="date" value={dateFilter} onChange={(e) => onDateFilter(e.target.value)}
              className="ml-1 rounded-sm border border-smoke-200 bg-white px-2 py-1 text-xs text-charcoal-600 focus:border-brand-500 focus:outline-none" />
            {hasActiveFilters && (
              <button onClick={() => { onStatusFilter(''); onDateFilter(''); onDatePreset?.('') }}
                className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-smoke-400 hover:text-charcoal-600 transition-colors"
                title="Limpar filtros">
                <X className="h-3 w-3" /> Limpar
              </button>
            )}
          </FilterBar>
        )}

        {/* Row 2: Status dots */}
        <FilterBar>
          {STATUS_OPTIONS.map((f) => (
            <FilterChip key={f.id || 's-all'} id={f.id} label={f.label}
              selected={statusFilter === f.id}
              onToggle={() => onStatusFilter(statusFilter === f.id ? '' : f.id)}
              dot={f.dot}
              count={f.id ? (statusCounts[f.id] ?? 0) : total} />
          ))}
        </FilterBar>
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}

      {loading && <PageSkeleton variant="spinner" />}

      {!loading && total === 0 && (
        <EmptyState icon={CalendarDays} title={EMPTY_STATES.reservations} />
      )}

      {!loading && total > 0 && (
        <div>
          {/* Column header — desktop */}
          <div className="hidden sm:flex items-center gap-3 px-1 pb-2 text-[10px] font-medium uppercase tracking-wider text-smoke-400 select-none">
            <span className="w-2" />
            <span className="w-10">Nº</span>
            <span className="flex-1">Cliente</span>
            <span className="w-8 text-right">Pax</span>
            <span className="w-12">Hora</span>
            <span className="w-8">Mesa</span>
            <span className="w-24 text-center">Status</span>
            <span className="w-44" />
          </div>

          {/* Rows */}
          <div className="border-t border-smoke-100">
            {reservations.map((r) => (
              <ReservationRow key={r.id} reservation={r}
                onCheckin={onCheckin} onComplete={onComplete} onCancel={onCancel} />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  )
}
