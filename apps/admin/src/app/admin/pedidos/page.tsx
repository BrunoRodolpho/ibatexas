'use client'

import { AdminPedidosPage } from '@ibatexas/ui'
import { useAdminOrdersPage } from '@/domains/admin/admin.hooks'

export default function PedidosPage() {
  const { orders, loading, page, totalPages, statusFilter, onStatusFilter, onPageChange } =
    useAdminOrdersPage()

  return (
    <AdminPedidosPage
      orders={orders}
      loading={loading}
      page={page}
      totalPages={totalPages}
      statusFilter={statusFilter}
      onStatusFilter={onStatusFilter}
      onPageChange={onPageChange}
    />
  )
}
