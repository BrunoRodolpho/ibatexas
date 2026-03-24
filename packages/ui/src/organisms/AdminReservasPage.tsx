'use client'

import { createColumnHelper } from '@tanstack/react-table'
import { RefreshCw } from 'lucide-react'
import { DataTable } from '../atoms/DataTable'
import { Badge } from '../atoms/Badge'
import { FilterChip } from '../molecules/FilterChip'

export interface AdminReservation {
  id: string
  customerName: string | null
  customerPhone: string | null
  partySize: number
  dateTime: string
  tableNumber: string | null
  status: 'pending' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show'
}

const STATUS_LABELS: Record<AdminReservation['status'], string> = {
  pending: 'Pendente',
  confirmed: 'Confirmada',
  seated: 'Sentada',
  completed: 'Completa',
  cancelled: 'Cancelada',
  no_show: 'No Show',
}

const STATUS_BADGE_VARIANT: Record<AdminReservation['status'], 'warning' | 'primary' | 'success' | 'default' | 'danger'> = {
  pending: 'warning',
  confirmed: 'primary',
  seated: 'success',
  completed: 'default',
  cancelled: 'danger',
  no_show: 'danger',
}

const STATUS_FILTERS = [
  { id: '', label: 'Todos' },
  { id: 'pending', label: 'Pendente' },
  { id: 'confirmed', label: 'Confirmada' },
  { id: 'seated', label: 'Sentada' },
  { id: 'completed', label: 'Completa' },
  { id: 'cancelled', label: 'Cancelada' },
  { id: 'no_show', label: 'No Show' },
] as const

const col = createColumnHelper<AdminReservation>()

function formatDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function truncateId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

export interface AdminReservasPageProps {
  reservations: AdminReservation[]
  loading: boolean
  dateFilter: string
  statusFilter: string
  onDateFilter: (date: string) => void
  onStatusFilter: (status: string) => void
  onCheckin: (id: string) => void
  onComplete: (id: string) => void
}

export function AdminReservasPage({
  reservations,
  loading,
  dateFilter,
  statusFilter,
  onDateFilter,
  onStatusFilter,
  onCheckin,
  onComplete,
}: Readonly<AdminReservasPageProps>) {
  const columns = [
    col.accessor('id', {
      header: 'ID',
      cell: (i) => (
        <span className="font-mono text-xs text-smoke-400" title={i.getValue()}>
          {truncateId(i.getValue())}
        </span>
      ),
    }),
    col.accessor('customerName', {
      header: 'Cliente',
      cell: (i) => i.getValue() ?? i.row.original.customerPhone ?? '—',
    }),
    col.accessor('partySize', { header: 'Pessoas' }),
    col.accessor('dateTime', {
      header: 'Data/Hora',
      cell: (i) => formatDateTime(i.getValue()),
    }),
    col.accessor('tableNumber', {
      header: 'Mesa',
      cell: (i) => i.getValue() ?? '—',
    }),
    col.accessor('status', {
      header: 'Status',
      cell: (i) => {
        const status = i.getValue()
        return (
          <Badge variant={STATUS_BADGE_VARIANT[status]}>
            {STATUS_LABELS[status]}
          </Badge>
        )
      },
    }),
    col.display({
      id: 'actions',
      header: '',
      cell: (i) => {
        const { id, status } = i.row.original
        return (
          <div className="flex gap-2">
            {status === 'confirmed' && (
              <button
                onClick={(e) => { e.stopPropagation(); onCheckin(id) }}
                className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700"
              >
                Check-in
              </button>
            )}
            {status === 'seated' && (
              <button
                onClick={(e) => { e.stopPropagation(); onComplete(id) }}
                className="rounded-md bg-charcoal-800 px-3 py-1 text-xs font-medium text-white hover:bg-charcoal-900"
              >
                Completar
              </button>
            )}
          </div>
        )
      },
    }),
  ]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-charcoal-900">Reservas</h1>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="date"
          value={dateFilter}
          onChange={(e) => onDateFilter(e.target.value)}
          className="rounded-md border border-smoke-200 bg-smoke-50 px-3 py-1.5 text-sm text-charcoal-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.id}
            id={f.id}
            label={f.label}
            selected={statusFilter === f.id}
            onToggle={() => onStatusFilter(statusFilter === f.id ? '' : f.id)}
          />
        ))}
        {(statusFilter || dateFilter) && (
          <button
            onClick={() => { onStatusFilter(''); onDateFilter('') }}
            className="flex items-center gap-1 text-sm text-smoke-400 hover:text-charcoal-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Limpar filtros
          </button>
        )}
      </div>

      <DataTable
        data={reservations}
        columns={columns}
        isLoading={loading}
        emptyMessage="Nenhuma reserva encontrada"
        pageSize={25}
      />
    </div>
  )
}
