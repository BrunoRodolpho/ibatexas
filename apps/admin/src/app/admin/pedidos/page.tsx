'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { AdminPedidosPage, AdminOrderDetailDrawer, useToast } from '@ibatexas/ui'
import type { OrderSummary } from '@ibatexas/types'
import type { AdminOrderDetail } from '@ibatexas/ui'
import { useAdminOrdersPage, useUpdateOrderStatus, useAdminOrderDetail } from '@/domains/admin/admin.hooks'
import { apiFetch } from '@/lib/api'

export default function PedidosPage(): React.JSX.Element {
  const { addToast } = useToast()
  const { orders, loading, page, totalPages, statusFilter, dateFilter, onStatusFilter, onDateFilter, onPageChange, refetch } =
    useAdminOrdersPage()

  const { updateStatus, updating } = useUpdateOrderStatus(refetch)

  // Drawer state
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const { order: orderDetail, refetch: refetchDetail } = useAdminOrderDetail(selectedOrderId)

  // Payment history for selected order
  const [paymentHistory, setPaymentHistory] = useState<Array<{id: string; method: string; status: string; amountInCentavos: number; createdAt: string; version: number}>>([])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset history when selection clears
    if (!selectedOrderId) { setPaymentHistory([]); return }
    apiFetch(`/api/admin/orders/${selectedOrderId}/payments`)
      .then((data: unknown) => {
        const d = data as { payments?: Array<{id: string; method: string; status: string; amountInCentavos: number; createdAt: string; version: number}> }
        setPaymentHistory(d?.payments ?? [])
      })
      .catch(() => setPaymentHistory([]))
  }, [selectedOrderId])

  // Track previous order count for sound alert
  const prevCountRef = useRef(orders.length)
  const hasInteractedRef = useRef(false)

  // Track first interaction to enable audio
  useEffect(() => {
    function markInteracted() { hasInteractedRef.current = true }
    document.addEventListener('click', markInteracted, { once: true })
    return () => document.removeEventListener('click', markInteracted)
  }, [])

  // Play notification beep when new orders arrive
  useEffect(() => {
    if (loading) return
    if (orders.length > prevCountRef.current && hasInteractedRef.current) {
      try {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.frequency.value = 800
        gain.gain.value = 0.3
        osc.start()
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
        osc.stop(ctx.currentTime + 0.3)
      } catch {
        // Audio not available
      }
    }
    prevCountRef.current = orders.length
  }, [orders.length, loading])

  const handleAdminAction = useCallback(async (orderId: string, action: string, body?: Record<string, unknown>) => {
    try {
      const pathMap: Record<string, { path: string; method: string }> = {
        'confirm-cash': { path: `/api/admin/orders/${orderId}/payment/confirm-cash`, method: 'POST' },
        'force-cancel': { path: `/api/admin/orders/${orderId}/force-cancel`, method: 'POST' },
        'refund': { path: `/api/admin/orders/${orderId}/payment/refund`, method: 'POST' },
        'waive': { path: `/api/admin/orders/${orderId}/waive`, method: 'POST' },
      }
      const cfg = pathMap[action]
      if (!cfg) return
      await apiFetch(cfg.path, {
        method: cfg.method,
        body: body ? JSON.stringify(body) : JSON.stringify({}),
      })
      addToast({ type: 'success', message: 'Ação realizada com sucesso' })
      if (selectedOrderId === orderId) refetchDetail()
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : `Erro ao executar ação: ${action}` })
      console.error(`Admin action ${action} failed:`, err)
    }
  }, [selectedOrderId, refetchDetail, addToast])

  async function handleAdvanceStatus(orderId: string, newStatus: string, version?: number) {
    try {
      await updateStatus(orderId, newStatus, version)
      addToast({ type: 'success', message: 'Status atualizado' })
      // Re-fetch drawer detail (status history) after successful mutation
      if (selectedOrderId === orderId) refetchDetail()
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Erro ao atualizar status' })
    }
  }

  function handleRowClick(order: OrderSummary) {
    setSelectedOrderId(order.id)
  }

  return (
    <>
      <AdminPedidosPage
        orders={orders}
        loading={loading}
        page={page}
        totalPages={totalPages}
        statusFilter={statusFilter}
        dateFilter={dateFilter}
        onStatusFilter={onStatusFilter}
        onDateFilter={onDateFilter}
        onPageChange={onPageChange}
        onAdvanceStatus={handleAdvanceStatus}
        advanceDisabled={updating}
        onRowClick={handleRowClick}
        onSuccess={(msg) => addToast({ type: 'success', message: msg })}
        onError={(msg) => addToast({ type: 'error', message: msg })}
      />

      <AdminOrderDetailDrawer
        order={(orderDetail as unknown as AdminOrderDetail) ?? null}
        open={selectedOrderId !== null}
        onClose={() => setSelectedOrderId(null)}
        onAdvanceStatus={handleAdvanceStatus}
        onAction={handleAdminAction}
        paymentHistory={paymentHistory}
      />
    </>
  )
}
