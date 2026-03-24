'use client'

import { AdminReservasPage } from '@ibatexas/ui'
import { useAdminReservationsPage } from '@/domains/admin/admin.hooks'

export default function ReservasPage() {
  const {
    reservations,
    loading,
    dateFilter,
    statusFilter,
    setDateFilter,
    setStatusFilter,
    checkin,
    complete,
  } = useAdminReservationsPage()

  return (
    <AdminReservasPage
      reservations={reservations}
      loading={loading}
      dateFilter={dateFilter}
      statusFilter={statusFilter}
      onDateFilter={setDateFilter}
      onStatusFilter={setStatusFilter}
      onCheckin={checkin}
      onComplete={complete}
    />
  )
}
