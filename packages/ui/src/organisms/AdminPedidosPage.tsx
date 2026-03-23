'use client'

import { createColumnHelper } from '@tanstack/react-table'
import { RefreshCw } from 'lucide-react'
import { DataTable } from '../atoms/DataTable'
import { Badge } from '../atoms/Badge'
import { FilterChip } from '../molecules/FilterChip'
import type { OrderSummary } from '@ibatexas/types'

const col = createColumnHelper<OrderSummary>()

function formatBRL(centavos: number) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function maskPhone(email: string) {
  // customerEmail may actually be a phone or email — mask for privacy
  if (email.length <= 6) return email
  return email.slice(0, 3) + '***' + email.slice(-3)
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'pendente',
  confirmed: 'confirmado',
  preparing: 'preparando',
  ready: 'pronto',
  delivered: 'entregue',
  canceled: 'cancelado',
  completed: 'concluído',
  requires_action: 'ação necessária',
}

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

function statusBadge(status: string) {
  return (
    <Badge variant={statusVariant(status)} className="text-xs">
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

const STATUS_FILTERS = [
  { id: '', label: 'Todos' },
  { id: 'pending', label: 'Pendente' },
  { id: 'confirmed', label: 'Confirmado' },
  { id: 'preparing', label: 'Preparando' },
  { id: 'ready', label: 'Pronto' },
  { id: 'delivered', label: 'Entregue' },
  { id: 'canceled', label: 'Cancelado' },
] as const

export interface AdminPedidosPageProps {
  orders: OrderSummary[]
  loading: boolean
  page: number
  totalPages: number
  statusFilter: string
  onStatusFilter: (status: string) => void
  onPageChange: (page: number) => void
}

export function AdminPedidosPage({
  orders,
  loading,
  page,
  totalPages,
  statusFilter,
  onStatusFilter,
  onPageChange,
}: Readonly<AdminPedidosPageProps>) {
  const columns = [
    col.accessor('displayId', {
      header: 'Pedido #',
      cell: (i) => `#${i.getValue()}`,
    }),
    col.accessor('customerEmail', {
      header: 'Cliente',
      cell: (i) => maskPhone(i.getValue() as string),
    }),
    col.accessor('itemCount', {
      header: 'Itens',
      cell: (i) => `${i.getValue()} item(s)`,
    }),
    col.accessor('total', {
      header: 'Total',
      cell: (i) => formatBRL(i.getValue() as number),
    }),
    col.accessor('status', {
      header: 'Status',
      cell: (i) => statusBadge(i.getValue() as string),
    }),
    col.accessor('paymentStatus', {
      header: 'Pagamento',
      cell: (i) => statusBadge(i.getValue() as string),
    }),
    col.accessor('createdAt', {
      header: 'Data',
      cell: (i) => {
        const d = new Date(i.getValue() as string)
        return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
      },
    }),
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal-900">Pedidos</h1>
        <p className="mt-1 text-sm text-smoke-400">Gerenciamento de pedidos</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
            className="flex items-center gap-1 text-sm text-smoke-400 hover:text-charcoal-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Limpar filtros
          </button>
        )}
      </div>

      <DataTable
        data={orders}
        columns={columns}
        isLoading={loading}
        emptyMessage="Nenhum pedido encontrado"
        pageSize={20}
      />

      {/* Server-side pagination */}
      {totalPages > 1 && !loading && (
        <div className="flex items-center justify-between text-sm text-charcoal-700">
          <span>Página {page} de {totalPages}</span>
          <div className="flex gap-2">
            <button
              className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
            >
              Anterior
            </button>
            <button
              className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              Próximo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
