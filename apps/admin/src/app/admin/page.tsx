'use client'

import { MEDUSA_ADMIN_URL } from '@/lib/api'
import { useAdminDashboard, useAdminOrders } from '@/domains/admin'
import { AdminDashboardPage } from '@ibatexas/ui'

export default function AdminDashboard(): React.JSX.Element {
  const { data: metrics, loading: metricsLoading } = useAdminDashboard()
  const { data: orders, loading: ordersLoading } = useAdminOrders({ limit: 10 })

  return (
    <AdminDashboardPage
      metrics={metrics}
      metricsLoading={metricsLoading}
      orders={orders}
      ordersLoading={ordersLoading}
      medusaAdminUrl={MEDUSA_ADMIN_URL}
    />
  )
}
