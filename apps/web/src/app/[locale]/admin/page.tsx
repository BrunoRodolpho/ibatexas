'use client'

import { useTranslations } from 'next-intl'
import { createColumnHelper } from '@tanstack/react-table'
import { MEDUSA_ADMIN_URL } from '@/lib/api'
import {
  ShoppingCart,
  DollarSign,
  CalendarDays,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react'
import { StatCard, DataTable, Badge } from '@/components/atoms'
import { useAdminDashboard, useAdminOrders } from '@/hooks/admin'
import type { OrderSummary } from '@ibatexas/types'

const col = createColumnHelper<OrderSummary>()

function formatBRL(centavos: number) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function statusBadge(status: string) {
  const map: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
    completed: 'success',
    pending: 'warning',
    canceled: 'danger',
    requires_action: 'warning',
  }
  const variant = map[status] ?? 'default'
  return <Badge variant={variant} className="text-xs">{status}</Badge>
}

const columns = [
  col.accessor('displayId', { header: '#', cell: (i) => `#${i.getValue()}` }),
  col.accessor('customerEmail', { header: 'Cliente' }),
  col.accessor('itemCount', { header: 'Itens', cell: (i) => `${i.getValue()} item(s)` }),
  col.accessor('total', { header: 'Total', cell: (i) => formatBRL(i.getValue() as number) }),
  col.accessor('status', { header: 'Status', cell: (i) => statusBadge(i.getValue() as string) }),
  col.accessor('paymentStatus', { header: 'Pagamento', cell: (i) => statusBadge(i.getValue() as string) }),
  col.accessor('createdAt', {
    header: 'Hora',
    cell: (i) => new Date(i.getValue() as string).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  }),
]

export default function AdminDashboard() {
  const t = useTranslations()
  const { data: metrics, loading: metricsLoading } = useAdminDashboard()
  const { data: orders, loading: ordersLoading } = useAdminOrders({ limit: 10 })

  return (
    <div className="space-y-6">
      {/* Page title */}
      <div>
        <h1 className="text-lg font-semibold text-charcoal-900">{t('admin.dashboard')}</h1>
        <p className="mt-1 text-sm text-smoke-400">Visão geral do dia</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={t('admin.orders_today')}
          value={metrics?.ordersToday ?? 0}
          icon={ShoppingCart}
          variant="info"
          isLoading={metricsLoading}
        />
        <StatCard
          label={t('admin.revenue_today')}
          value={metrics ? formatBRL(metrics.revenueToday) : 'R$ 0,00'}
          icon={DollarSign}
          variant="success"
          isLoading={metricsLoading}
        />
        <StatCard
          label={t('admin.active_reservations')}
          value={metrics?.activeReservations ?? 0}
          icon={CalendarDays}
          subLabel={t('admin.step_8_label')}
          isLoading={metricsLoading}
        />
        <StatCard
          label={t('admin.pending_escalations')}
          value={metrics?.pendingEscalations ?? 0}
          icon={AlertTriangle}
          variant={metrics && metrics.pendingEscalations > 0 ? 'danger' : 'default'}
          subLabel={t('admin.step_9_label')}
          isLoading={metricsLoading}
        />
      </div>

      {/* Recent orders */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-charcoal-900">
            {t('admin.recent_orders')}
          </h2>
          <a
            href={`${MEDUSA_ADMIN_URL}/app/orders`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs font-medium text-smoke-400 hover:text-charcoal-700"
          >
            Ver todos
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <DataTable
          data={orders}
          columns={columns}
          isLoading={ordersLoading}
          emptyMessage={t('admin.no_orders_today')}
        />
      </div>
    </div>
  )
}
