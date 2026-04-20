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
    datePreset,
    statusFilter,
    setDateFilter,
    setDatePreset,
    setStatusFilter,
    checkin,
    complete,
    cancel,
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

  const handleCancel = useCallback(async (id: string) => {
    try {
      await cancel(id)
      addToast({ type: 'success', message: 'Reserva cancelada' })
    } catch (e) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'Erro ao cancelar reserva' })
    }
  }, [cancel, addToast])

  return (
    <AdminReservasPage
      reservations={reservations}
      loading={loading}
      dateFilter={dateFilter}
      datePreset={datePreset}
      statusFilter={statusFilter}
      onDateFilter={setDateFilter}
      onDatePreset={setDatePreset}
      onStatusFilter={setStatusFilter}
      onCheckin={handleCheckin}
      onComplete={handleComplete}
      onCancel={handleCancel}
      onSuccess={(msg) => addToast({ type: 'success', message: msg })}
      onError={(msg) => addToast({ type: 'error', message: msg })}
    />
  )
}
