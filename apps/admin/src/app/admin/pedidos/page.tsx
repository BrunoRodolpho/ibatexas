'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { AdminPedidosPage, AdminOrderDetailDrawer, useToast } from '@ibatexas/ui'
import type { OrderSummary } from '@ibatexas/types'
import type { AdminOrderDetail } from '@ibatexas/ui'
import { useAdminOrdersPage, useUpdateOrderStatus, useAdminOrderDetail } from '@/domains/admin/admin.hooks'
import { apiFetch } from '@/lib/api'
import { reaisStringToCentavos, INVALID_AMOUNT_PT_BR } from '@/lib/money'
import { AdminActionDialog } from '@/components/molecules/AdminActionDialog'
import {
  PendingConfirmationsPanel,
  confirmationRouteKey,
  type PendingConfirmation,
} from '@/components/molecules/PendingConfirmationsPanel'

// OPS-071 — two-phase destructive admin actions. Each triggers a collect →
// (optional) confirm flow: step 1 (`POST path`) either executes directly or
// parks a receipt and returns 202 `{ confirmationId, prompt }`; step 2
// (`POST path/confirm`) must be issued by a different operator.
type TwoPhaseAction = 'force-cancel' | 'refund' | 'waive'

const ACTION_META: Record<TwoPhaseAction, {
  title: string
  path: (orderId: string) => string
  reasonRequired: boolean
  withAmount: boolean
}> = {
  'force-cancel': { title: 'Forçar cancelamento', path: (id) => `/api/admin/orders/${id}/force-cancel`, reasonRequired: false, withAmount: false },
  'refund': { title: 'Reembolsar pagamento', path: (id) => `/api/admin/orders/${id}/payment/refund`, reasonRequired: false, withAmount: true },
  'waive': { title: 'Isentar pagamento', path: (id) => `/api/admin/orders/${id}/waive`, reasonRequired: true, withAmount: false },
}

// Step-2 confirm path per receipt route key. The three dialog-driven actions
// reuse ACTION_META; force-status has no collect dialog on this page but its
// parked receipts must still be confirmable here.
const CONFIRM_PATH_BY_ROUTE: Record<string, (orderId: string) => string> = {
  'force-cancel': ACTION_META['force-cancel'].path,
  'refund': ACTION_META['refund'].path,
  'waive': ACTION_META['waive'].path,
  'force-status': (id) => `/api/admin/orders/${id}/payment/status`,
}

// Step-2 POST shared by the dialog flow and the pending-confirmations panel.
// Raw fetch (not apiFetch) so the server's pt-BR error body is surfaced
// verbatim (e.g. the same-actor 403 "outro operador precisa confirmar").
async function postConfirmStep(
  path: string,
  confirmationId: string,
): Promise<{ ok: boolean; status: number; data: { error?: string; message?: string } }> {
  const res = await fetch(`/api/proxy${path}/confirm`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmationId }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
  return { ok: res.ok, status: res.status, data }
}

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

  // Two-phase destructive action flow (OPS-071).
  const [pendingAction, setPendingAction] = useState<{
    orderId: string
    kind: TwoPhaseAction
    phase: 'collect' | 'confirm'
    path: string
    confirmationId?: string
    prompt?: string
  } | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  // Bumped on each new action so the dialog remounts with fresh inputs.
  const [dialogKey, setDialogKey] = useState(0)

  // Receipts parked at step 1 and awaiting a second operator (OPS-071).
  // Polled on the same 30s cadence as the orders auto-refresh.
  const [confirmations, setConfirmations] = useState<PendingConfirmation[]>([])
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const refetchConfirmations = useCallback(async () => {
    try {
      const data = (await apiFetch('/api/admin/confirmations')) as
        | PendingConfirmation[]
        | { confirmations?: PendingConfirmation[] }
        | null
      const list = Array.isArray(data) ? data : (data?.confirmations ?? [])
      setConfirmations(
        list.filter((c): c is PendingConfirmation => typeof c?.confirmationId === 'string' && c.confirmationId.length > 0),
      )
    } catch {
      // Endpoint unavailable — hide the panel instead of toast-spamming a poll.
      setConfirmations([])
    }
  }, [])

  useEffect(() => {
    void refetchConfirmations()
    const interval = setInterval(() => { void refetchConfirmations() }, 30_000)
    return () => clearInterval(interval)
  }, [refetchConfirmations])

  // Second-operator confirm fired from the panel (the initiator's own confirm
  // attempt gets the server's same-actor 403, surfaced verbatim below).
  const confirmFromPanel = useCallback(async (confirmation: PendingConfirmation) => {
    const routeKey = confirmationRouteKey(confirmation)
    const pathFor = routeKey ? CONFIRM_PATH_BY_ROUTE[routeKey] : undefined
    if (!pathFor || !confirmation.orderId) return
    setConfirmingId(confirmation.confirmationId)
    try {
      const { ok, status, data } = await postConfirmStep(pathFor(confirmation.orderId), confirmation.confirmationId)
      if (!ok) {
        addToast({ type: 'error', message: data.error ?? data.message ?? `Erro ao confirmar (${status})` })
      } else {
        addToast({ type: 'success', message: data.message ?? 'Ação confirmada e executada' })
        refetch()
        if (selectedOrderId === confirmation.orderId) refetchDetail()
      }
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Erro ao confirmar ação' })
    } finally {
      setConfirmingId(null)
      void refetchConfirmations()
    }
  }, [addToast, refetch, refetchDetail, selectedOrderId, refetchConfirmations])

  const handleAdminAction = useCallback(async (orderId: string, action: string, body?: Record<string, unknown>) => {
    // confirm-cash is a direct (non-two-phase) action — execute immediately.
    if (action === 'confirm-cash') {
      try {
        await apiFetch(`/api/admin/orders/${orderId}/payment/confirm-cash`, {
          method: 'POST',
          body: body ? JSON.stringify(body) : JSON.stringify({}),
        })
        addToast({ type: 'success', message: 'Ação realizada com sucesso' })
        if (selectedOrderId === orderId) refetchDetail()
      } catch (err) {
        addToast({ type: 'error', message: err instanceof Error ? err.message : `Erro ao executar ação: ${action}` })
        console.error(`Admin action ${action} failed:`, err)
      }
      return
    }
    // Destructive two-phase actions: open the collect dialog; the step-1 POST
    // fires on submit (so we can gather the required reason / refund amount).
    if (action in ACTION_META) {
      const kind = action as TwoPhaseAction
      setDialogKey((k) => k + 1)
      setPendingAction({ orderId, kind, phase: 'collect', path: ACTION_META[kind].path(orderId) })
    }
  }, [selectedOrderId, refetchDetail, addToast])

  // Step 1 — POST the destructive action. A 202 receipt (confirmationId) means
  // it was PARKED pending a second operator; anything else means it executed.
  const submitCollectAction = useCallback(async (reason: string, amountReais: string) => {
    if (!pendingAction) return
    const payload: Record<string, unknown> = {}
    if (reason) payload.reason = reason
    if (pendingAction.kind === 'refund' && amountReais.trim()) {
      const cents = reaisStringToCentavos(amountReais)
      if (cents === null) {
        // The dialog validates client-side; this guard keeps an unparseable
        // amount from ever silently degrading into a FULL refund.
        addToast({ type: 'error', message: INVALID_AMOUNT_PT_BR })
        return
      }
      payload.amountInCentavos = cents
    }
    setActionLoading(true)
    try {
      // Refund step 1 requires an Idempotency-Key header (400 otherwise).
      const headers: Record<string, string> =
        pendingAction.kind === 'refund' ? { 'Idempotency-Key': crypto.randomUUID() } : {}
      const result = (await apiFetch(pendingAction.path, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })) as { confirmationId?: string; prompt?: string }
      if (result?.confirmationId) {
        setPendingAction((prev) =>
          prev ? { ...prev, phase: 'confirm', confirmationId: result.confirmationId, prompt: result.prompt ?? 'Confirmar esta ação?' } : prev,
        )
        // The parked receipt is now visible to other operators' panels too.
        void refetchConfirmations()
      } else {
        // Executed directly (e.g. a small refund below the confirmation threshold).
        addToast({ type: 'success', message: 'Ação realizada com sucesso' })
        if (selectedOrderId === pendingAction.orderId) refetchDetail()
        setPendingAction(null)
      }
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Erro ao executar ação' })
      setPendingAction(null)
    } finally {
      setActionLoading(false)
    }
  }, [pendingAction, selectedOrderId, refetchDetail, addToast, refetchConfirmations])

  // Step 2 — the second-operator confirmation. Raw fetch (not apiFetch) so we
  // can surface the server's pt-BR error body (e.g. the same-actor 403).
  const confirmPendingAction = useCallback(async () => {
    if (!pendingAction?.confirmationId) return
    setActionLoading(true)
    try {
      const { ok, status, data } = await postConfirmStep(pendingAction.path, pendingAction.confirmationId)
      if (!ok) {
        addToast({ type: 'error', message: data.error ?? data.message ?? `Erro ao confirmar (${status})` })
      } else {
        addToast({ type: 'success', message: data.message ?? 'Ação confirmada e executada' })
        if (selectedOrderId === pendingAction.orderId) refetchDetail()
        refetch()
      }
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Erro ao confirmar ação' })
    } finally {
      setActionLoading(false)
      setPendingAction(null)
      void refetchConfirmations()
    }
  }, [pendingAction, selectedOrderId, refetchDetail, refetch, addToast, refetchConfirmations])

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
      <PendingConfirmationsPanel
        confirmations={confirmations}
        confirmingId={confirmingId}
        onConfirm={confirmFromPanel}
      />

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

      <AdminActionDialog
        key={dialogKey}
        open={pendingAction !== null}
        phase={pendingAction?.phase ?? 'collect'}
        title={pendingAction ? ACTION_META[pendingAction.kind].title : ''}
        reasonRequired={pendingAction ? ACTION_META[pendingAction.kind].reasonRequired : false}
        withAmount={pendingAction ? ACTION_META[pendingAction.kind].withAmount : false}
        prompt={pendingAction?.prompt ?? ''}
        loading={actionLoading}
        onSubmitCollect={submitCollectAction}
        onConfirm={confirmPendingAction}
        onCancel={() => setPendingAction(null)}
      />
    </>
  )
}
