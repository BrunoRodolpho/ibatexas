'use client'

import {
  ShoppingCart,
  DollarSign,
  CalendarDays,
  AlertTriangle,
  LayoutDashboard,
} from 'lucide-react'
import { createColumnHelper } from '@tanstack/react-table'
import { StatCard } from '../atoms/StatCard'
import { DataTable } from '../atoms/DataTable'
import { Badge } from '../atoms/Badge'
import { PageHeader } from '../atoms/PageHeader'
import { SectionHeader } from '../atoms/SectionHeader'
import { PageShell } from '../layouts/PageShell'
import type { AdminDashboardMetrics, OrderSummary } from '@ibatexas/types'
import {
  ORDER_COLUMN_HEADERS,
  PAGE_TITLES,
  DASHBOARD_STAT_LABELS,
  ACTION_LABELS,
  EMPTY_STATES,
  MISC_LABELS,
} from '../constants/admin-labels'

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
  col.accessor('displayId', { header: ORDER_COLUMN_HEADERS.orderId, cell: (i) => `#${i.getValue()}` }),
  col.accessor('customerEmail', { header: ORDER_COLUMN_HEADERS.customer }),
  col.accessor('itemCount', { header: ORDER_COLUMN_HEADERS.items, cell: (i) => MISC_LABELS.itemCount(i.getValue() as number) }),
  col.accessor('total', { header: ORDER_COLUMN_HEADERS.total, cell: (i) => formatBRL(i.getValue() as number) }),
  col.accessor('status', { header: ORDER_COLUMN_HEADERS.status, cell: (i) => statusBadge(i.getValue() as string) }),
  col.accessor('paymentStatus', { header: ORDER_COLUMN_HEADERS.payment, cell: (i) => statusBadge(i.getValue() as string) }),
  col.accessor('createdAt', {
    header: ORDER_COLUMN_HEADERS.time,
    cell: (i) => new Date(i.getValue() as string).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  }),
]

export interface AdminDashboardPageProps {
  metrics: AdminDashboardMetrics | null
  metricsLoading: boolean
  orders: OrderSummary[]
  ordersLoading: boolean
  medusaAdminUrl: string
  onOrderClick?: (order: OrderSummary) => void
}

export function AdminDashboardPage({
  metrics,
  metricsLoading,
  orders,
  ordersLoading,
  onOrderClick,
}: Readonly<AdminDashboardPageProps>) {
  return (
    <PageShell>
      <PageHeader icon={LayoutDashboard} title={PAGE_TITLES.dashboard} subtitle={PAGE_TITLES.dashboardSubtitle} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={DASHBOARD_STAT_LABELS.ordersToday}
          value={metrics?.ordersToday ?? 0}
          icon={ShoppingCart}
          variant="info"
          isLoading={metricsLoading}
        />
        <StatCard
          label={DASHBOARD_STAT_LABELS.revenueToday}
          value={metrics ? formatBRL(metrics.revenueToday) : 'R$ 0,00'}
          icon={DollarSign}
          variant="success"
          isLoading={metricsLoading}
        />
        <StatCard
          label={DASHBOARD_STAT_LABELS.activeReservations}
          value={metrics?.activeReservations ?? 0}
          icon={CalendarDays}
          subLabel="Step 8"
          isLoading={metricsLoading}
        />
        <StatCard
          label={DASHBOARD_STAT_LABELS.pendingEscalations}
          value={metrics?.pendingEscalations ?? 0}
          icon={AlertTriangle}
          variant={metrics && metrics.pendingEscalations > 0 ? 'danger' : 'default'}
          subLabel="Step 9"
          isLoading={metricsLoading}
        />
      </div>

      <div>
        <div className="mb-3">
          <SectionHeader
            title={DASHBOARD_STAT_LABELS.recentOrders}
            action={
              <a href="/admin/pedidos" className="flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)] hover:text-charcoal-700">
                {ACTION_LABELS.viewAll}
              </a>
            }
          />
        </div>
        <DataTable
          data={orders}
          columns={columns}
          isLoading={ordersLoading}
          emptyMessage={EMPTY_STATES.ordersToday}
          onRowClick={onOrderClick}
        />
      </div>
    </PageShell>
  )
}
