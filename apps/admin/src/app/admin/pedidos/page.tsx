'use client'

import { AdminPedidosPage, useToast } from '@ibatexas/ui'
import { useAdminOrdersPage } from '@/domains/admin/admin.hooks'

export default function PedidosPage(): React.JSX.Element {
  const { addToast } = useToast()
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
      onSuccess={(msg) => addToast({ type: 'success', message: msg })}
      onError={(msg) => addToast({ type: 'error', message: msg })}
    />
  )
}
