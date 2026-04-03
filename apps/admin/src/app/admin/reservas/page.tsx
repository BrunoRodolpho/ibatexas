'use client'

import { useCallback } from 'react'
import { AdminReservasPage, useToast } from '@ibatexas/ui'
import { useAdminReservationsPage } from '@/domains/admin/admin.hooks'

export default function ReservasPage(): React.JSX.Element {
  const { addToast } = useToast()
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

  const handleCheckin = useCallback(async (id: string) => {
    try {
      await checkin(id)
      addToast({ type: 'success', message: 'Check-in realizado' })
    } catch (e) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'Erro ao realizar check-in' })
    }
  }, [checkin, addToast])

  const handleComplete = useCallback(async (id: string) => {
    try {
      await complete(id)
      addToast({ type: 'success', message: 'Reserva finalizada' })
    } catch (e) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'Erro ao finalizar reserva' })
    }
  }, [complete, addToast])

  return (
    <AdminReservasPage
      reservations={reservations}
      loading={loading}
      dateFilter={dateFilter}
      statusFilter={statusFilter}
      onDateFilter={setDateFilter}
      onStatusFilter={setStatusFilter}
      onCheckin={handleCheckin}
      onComplete={handleComplete}
      onSuccess={(msg) => addToast({ type: 'success', message: msg })}
      onError={(msg) => addToast({ type: 'error', message: msg })}
    />
  )
}
