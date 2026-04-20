'use client'

import { createColumnHelper } from '@tanstack/react-table'
import { RefreshCw, ClipboardList } from 'lucide-react'
import { DataTable } from '../atoms/DataTable'
import { Badge } from '../atoms/Badge'
import { PageHeader } from '../atoms/PageHeader'
import { PageShell } from '../layouts/PageShell'
import { FilterChip } from '../molecules/FilterChip'
import { FilterBar } from '../molecules/FilterBar'
import type { OrderSummary, OrderFulfillmentStatus } from '@ibatexas/types'
import { getNextStatus, formatOrderId } from '@ibatexas/types'
import {
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  ORDER_STATUS_FILTERS,
  ORDER_DATE_FILTERS,
  ORDER_COLUMN_HEADERS,
  PAGE_TITLES,
  ACTION_LABELS,
  EMPTY_STATES,
  MISC_LABELS,
} from '../constants/admin-labels'

const col = createColumnHelper<OrderSummary>()

function formatBRL(centavos: number) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function maskPhone(email: string) {
  // customerEmail may actually be a phone or email — mask for privacy
  if (email.length <= 6) return email
  return email.slice(0, 3) + '***' + email.slice(-3)
}

const STATUS_LABELS = ORDER_STATUS_LABELS

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  const map: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
    completed: 'success',
    delivered: 'success',
    confirmed: 'success',
    pending: 'warning',
    preparing: 'warning',
    ready: 'info' as 'warning',
    requires_action: 'warning',
    canceled: 'danger',
  }
  return map[status] ?? 'default'
}

function paymentVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  const map: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
    paid: 'success',
    captured: 'success',
    awaiting_payment: 'warning',
    payment_pending: 'warning',
    cash_pending: 'warning',
    switching_method: 'warning',
    pending: 'warning',
    payment_expired: 'danger',
    payment_failed: 'danger',
    canceled: 'danger',
  }
  return map[status] ?? 'default'
}

function statusBadge(status: string) {
  return (
    <Badge variant={statusVariant(status)} className="text-xs">
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

const STATUS_FILTERS = ORDER_STATUS_FILTERS

export interface AdminPedidosPageProps {
  orders: OrderSummary[]
  loading: boolean
  page: number
  totalPages: number
  statusFilter: string
  dateFilter?: string
  onStatusFilter: (status: string) => void
  onDateFilter?: (preset: string) => void
  onPageChange: (page: number) => void
  onAdvanceStatus?: (orderId: string, newStatus: string, version?: number) => void
  advanceDisabled?: boolean
  onRowClick?: (order: OrderSummary) => void
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

export function AdminPedidosPage({
  orders,
  loading,
  page,
  totalPages,
  statusFilter,
  dateFilter,
  onStatusFilter,
  onDateFilter,
  onPageChange,
  onAdvanceStatus,
  advanceDisabled,
  onRowClick,
}: Readonly<AdminPedidosPageProps>) {
  const columns = [
    col.accessor('displayId', {
      header: ORDER_COLUMN_HEADERS.displayId,
      cell: (i) => formatOrderId(i.getValue() as number),
    }),
    col.accessor('customerEmail', {
      header: ORDER_COLUMN_HEADERS.customer,
      cell: (i) => maskPhone(i.getValue() as string),
    }),
    col.accessor('itemCount', {
      header: ORDER_COLUMN_HEADERS.items,
      cell: (i) => MISC_LABELS.itemCount(i.getValue() as number),
    }),
    col.accessor('total', {
      header: ORDER_COLUMN_HEADERS.total,
      cell: (i) => formatBRL(i.getValue() as number),
    }),
    col.accessor('status', {
      header: ORDER_COLUMN_HEADERS.status,
      cell: (i) => statusBadge(i.getValue() as string),
    }),
    col.accessor('paymentStatus', {
      header: ORDER_COLUMN_HEADERS.payment,
      cell: (i) => {
        const v = i.getValue() as string
        return (
          <Badge variant={paymentVariant(v)} className="text-xs">
            {PAYMENT_STATUS_LABELS[v] ?? STATUS_LABELS[v] ?? v}
          </Badge>
        )
      },
    }),
    col.accessor('createdAt', {
      header: ORDER_COLUMN_HEADERS.date,
      cell: (i) => {
        const d = new Date(i.getValue() as string)
        return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
      },
    }),
    ...(onAdvanceStatus ? [col.display({
      id: 'actions',
      header: '',
      cell: (i) => {
        const row = i.row.original as OrderSummary & { version?: number }
        const { id, status } = row
        const next = getNextStatus(status as OrderFulfillmentStatus)
        if (!next) return null

        const labels: Record<string, string> = {
          confirmed: ACTION_LABELS.confirmOrder,
          preparing: ACTION_LABELS.startPreparing,
          ready: ACTION_LABELS.markReady,
          in_delivery: ACTION_LABELS.sendDelivery,
          delivered: ACTION_LABELS.markDelivered,
        }

        return (
          <button
            onClick={(e) => { e.stopPropagation(); onAdvanceStatus(id, next, row.version) }}
            disabled={advanceDisabled}
            className="rounded-sm bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {labels[next] ?? ACTION_LABELS.advanceStatus}
          </button>
        )
      },
    })] : []),
  ]

  return (
    <PageShell>
      <PageHeader icon={ClipboardList} title={PAGE_TITLES.orders} subtitle={PAGE_TITLES.ordersSubtitle} />

      <FilterBar>
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.id || 'all'}
            id={f.id || 'all'}
            label={f.label}
            selected={statusFilter === f.id}
            onToggle={() => onStatusFilter(f.id)}
          />
        ))}
        {statusFilter && (
          <button
            onClick={() => onStatusFilter('')}
            className="flex items-center gap-1 text-sm text-[var(--color-text-secondary)] hover:text-charcoal-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {ACTION_LABELS.clearFilters}
          </button>
        )}
      </FilterBar>

      {onDateFilter && (
        <FilterBar>
          {ORDER_DATE_FILTERS.map((f) => (
            <FilterChip
              key={f.id || 'date-all'}
              id={f.id || 'date-all'}
              label={f.label}
              selected={(dateFilter ?? '') === f.id}
              onToggle={() => onDateFilter(f.id)}
            />
          ))}
        </FilterBar>
      )}

      <DataTable
        data={orders}
        columns={columns}
        isLoading={loading}
        emptyMessage={EMPTY_STATES.orders}
        pageSize={20}
        onRowClick={onRowClick}
      />

      {/* Server-side pagination */}
      {totalPages > 1 && !loading && (
        <div className="flex items-center justify-between text-sm text-charcoal-700">
          <span>{MISC_LABELS.pageOf(page, totalPages)}</span>
          <div className="flex gap-2">
            <button
              className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
            >
              {ACTION_LABELS.previous}
            </button>
            <button
              className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              {ACTION_LABELS.next}
            </button>
          </div>
        </div>
      )}
    </PageShell>
  )
}
