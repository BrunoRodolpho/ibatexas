'use client'

import { useTranslations, useLocale } from 'next-intl'
import Link from 'next/link'
import { type ColumnDef, createColumnHelper } from '@tanstack/react-table'
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const columns: ColumnDef<OrderSummary, any>[] = [
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
  const locale = useLocale()
  const { data: metrics, loading: metricsLoading } = useAdminDashboard()
  const { data: orders, loading: ordersLoading } = useAdminOrders({ limit: 10 })

  return (
    <div className="space-y-8">
      {/* Page title */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">{t('admin.dashboard')}</h1>
        <a
          href="http://localhost:9000/app"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
        >
          Medusa Admin
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={t('admin.orders_today')}
          value={metrics?.ordersToday ?? 0}
          icon={ShoppingCart}
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

      {/* Quick actions */}
      <div className="flex flex-wrap gap-3">
        <Link
          href={`/${locale}/admin/cardapio`}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {t('admin.menu')} →
        </Link>
        <Link
          href={`/${locale}/admin/loja`}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {t('admin.shop')} →
        </Link>
        <a
          href="http://localhost:9000/app/orders"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {t('admin.orders')} (Medusa)
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Recent orders */}
      <div>
        <h2 className="mb-4 text-base font-semibold text-slate-900">
          {t('admin.recent_orders')}
        </h2>
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
