'use client'

import { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@ibatexas/ui/atoms'
import { Modal } from '@ibatexas/ui/molecules'
import { apiFetch } from '@/lib/api'
import { submitOrderCancel, submitOrderCancelConfirm } from '@/domains/orders/cancelConfirm'
import { AmendOrderDialog } from './AmendOrderDialog'
import { SwitchTypeDialog } from './SwitchTypeDialog'

interface CurrentPayment {
  id: string
  method: string
  status: string
  pixExpiresAt?: string | null
}

export interface OrderActionItem {
  id: string
  title: string
  quantity: number
  variant_id: string
  unit_price: number
  productType?: 'food' | 'frozen' | 'merchandise'
}

interface OrderActionsProps {
  readonly orderId: string
  readonly fulfillmentStatus: string
  readonly currentPayment: CurrentPayment | null
  readonly orderType?: string
  readonly items?: OrderActionItem[]
  /** Called after any mutation so parent can refetch */
  readonly onMutate: () => void
}

type ActiveAction = 'cancel' | 'retry' | 'regen_pix' | 'switch_method' | null

export function OrderActions({ orderId, fulfillmentStatus, currentPayment, orderType, items, onMutate }: OrderActionsProps) {
  const t = useTranslations('order')
  const tp = useTranslations('payment')
  const [cancelOpen, setCancelOpen] = useState(false)
  const [amendOpen, setAmendOpen] = useState(false)
  const [typeOpen, setTypeOpen] = useState(false)
  const [activeAction, setActiveAction] = useState<ActiveAction>(null)
  const [errorMsg, setErrorMsg] = useState('')
  // BKL-036: a PAID order does not cancel synchronously — the kernel PARKS it
  // (HTTP 202 { confirmationRequired }). This holds an honest notice (expiry /
  // refusal) shown inside the still-open cancel modal.
  const [cancelNotice, setCancelNotice] = useState('')
  // BKL-146/FE-D19 — the parked cancel's receipt + the KERNEL's prompt. When set,
  // the modal shows step-2: restate the prompt VERBATIM + a "confirm" button that
  // COMPLETES the cancel via POST /api/orders/:id/cancel/confirm.
  const [cancelConfirm, setCancelConfirm] = useState<{ confirmationId: string; prompt: string } | null>(null)

  const isBusy = activeAction !== null

  const paymentStatus = currentPayment?.status ?? null
  const paymentMethod = currentPayment?.method ?? null

  // ── Action visibility (matrix-driven) ──────────────────────────────────
  const editable = ['pending', 'confirmed'].includes(fulfillmentStatus)
  const hasNonFoodItems = items?.some(i => i.productType !== 'food') ?? false
  const canAmend = (editable || (fulfillmentStatus === 'preparing' && hasNonFoodItems)) && (items?.length ?? 0) > 0
  const canSwitchType = editable
  const canCancel = editable

  // Payment actions
  const canRetry = ['payment_failed', 'payment_expired'].includes(paymentStatus ?? '')
  const canRegenPix = paymentStatus === 'payment_expired' && paymentMethod === 'pix'
  const canSwitchMethod = ['awaiting_payment', 'payment_expired', 'payment_failed'].includes(paymentStatus ?? '')

  // ── Action handlers ────────────────────────────────────────────────────
  async function doAction(action: ActiveAction, path: string, method: string, errorKey: string, body?: Record<string, unknown>) {
    setActiveAction(action)
    setErrorMsg('')
    try {
      await apiFetch(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      })
      onMutate()
    } catch {
      setErrorMsg(errorKey)
    } finally {
      setActiveAction(null)
    }
  }

  const handleCancel = useCallback(async () => {
    // Keep the modal open during the request — close only on a real (executed)
    // cancel. A PAID order PARKS (202) → step-2 confirm, NEVER a false success.
    setActiveAction('cancel')
    setErrorMsg('')
    setCancelNotice('')
    const result = await submitOrderCancel(orderId)
    setActiveAction(null)
    switch (result.kind) {
      case 'executed':
        setCancelOpen(false)
        onMutate()
        return
      case 'needs_confirmation':
        // BKL-146/FE-D19 — the paid cancel PARKED. Advance to step-2: restate
        // the kernel's prompt and let the customer COMPLETE it. NOT cancelled yet.
        setCancelConfirm({ confirmationId: result.confirmationId, prompt: result.prompt })
        onMutate()
        return
      case 'not_allowed':
        setErrorMsg(result.message ?? t('cancel_error'))
        return
      default:
        setErrorMsg(t('cancel_error'))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  const handleCancelConfirm = useCallback(async () => {
    if (!cancelConfirm) return
    // Step-2 — COMPLETE the parked cancel through the kernel's confirmationReceipt.
    setActiveAction('cancel')
    setErrorMsg('')
    setCancelNotice('')
    const result = await submitOrderCancelConfirm(orderId, cancelConfirm.confirmationId)
    setActiveAction(null)
    switch (result.kind) {
      case 'executed':
        setCancelConfirm(null)
        setCancelOpen(false)
        onMutate()
        return
      case 'expired':
        // Single-use receipt expired / already used — drop step-2 + honest notice.
        setCancelConfirm(null)
        setCancelNotice(t('cancel_confirmation_expired'))
        onMutate()
        return
      case 'not_allowed':
        // The order moved past the cancel window since the park (or an IDOR
        // refusal) — surface the server's honest message, drop step-2.
        setCancelConfirm(null)
        setCancelNotice(result.message ?? t('cancel_error'))
        onMutate()
        return
      default:
        setErrorMsg(t('cancel_error'))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, cancelConfirm])

  const handleRetry = useCallback(async () => {
    await doAction('retry', `/api/orders/${orderId}/payment/retry`, 'POST', tp('retry_error'), {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  const handleRegenPix = useCallback(async () => {
    await doAction('regen_pix', `/api/orders/${orderId}/payment/regenerate-pix`, 'POST', tp('regenerate_error'), {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  const handleSwitchMethod = useCallback(async (newMethod: string) => {
    await doAction('switch_method', `/api/orders/${orderId}/payment/method`, 'PATCH', tp('switch_error'), { method: newMethod })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  const hasAnyAction = canCancel || canRetry || canRegenPix || canSwitchMethod || canAmend || canSwitchType
  if (!hasAnyAction) return null

  // Contextual switch-type label
  let switchTypeLabel: string
  if (orderType === 'delivery') {
    switchTypeLabel = t('switch_type_to_pickup')
  } else if (orderType === 'pickup') {
    switchTypeLabel = t('switch_type_to_delivery')
  } else {
    switchTypeLabel = t('switch_type_to_dine_in')
  }

  // Available payment method switch targets (exclude current)
  const switchTargets = ['pix', 'card', 'cash'].filter((m) => m !== paymentMethod)

  // Cancel modal footer — two-step: step-1 asks to cancel; step-2 (a PAID order
  // that PARKED) COMPLETES the kernel-parked cancel via the confirm endpoint.
  const cancelFooter = cancelConfirm ? (
    <div className="flex gap-2 justify-end">
      <Button variant="secondary" size="sm" disabled={activeAction === 'cancel'} onClick={() => { setCancelOpen(false); setCancelConfirm(null); setCancelNotice('') }}>
        {t('cancel_confirm_no')}
      </Button>
      <Button variant="danger" size="sm" isLoading={activeAction === 'cancel'} onClick={handleCancelConfirm}>
        {t('cancel_confirm_complete')}
      </Button>
    </div>
  ) : (
    <div className="flex gap-2 justify-end">
      <Button variant="secondary" size="sm" disabled={activeAction === 'cancel'} onClick={() => { setCancelOpen(false); setCancelNotice('') }}>
        {t('cancel_confirm_no')}
      </Button>
      <Button variant="danger" size="sm" isLoading={activeAction === 'cancel'} onClick={handleCancel}>
        {t('cancel_confirm_yes')}
      </Button>
    </div>
  )

  return (
    <>
      <div className="mt-4 pt-4 border-t border-smoke-200">
        {/* Error feedback */}
        {errorMsg && (
          <p className="text-xs text-accent-red mb-3">{errorMsg}</p>
        )}

        {/* Payment actions — most urgent */}
        {(canRetry || canRegenPix || canSwitchMethod) && (
          <div className="flex flex-wrap gap-2 mb-3">
            {canRetry && !canRegenPix && (
              <Button variant="secondary" size="sm" disabled={isBusy} isLoading={activeAction === 'retry'} onClick={handleRetry}>
                {tp('retry')}
              </Button>
            )}
            {canRegenPix && (
              <Button variant="secondary" size="sm" disabled={isBusy} isLoading={activeAction === 'regen_pix'} onClick={handleRegenPix}>
                {tp('regenerate_pix')}
              </Button>
            )}
            {canSwitchMethod && switchTargets.map((method) => (
              <Button
                key={method}
                variant="tertiary"
                size="sm"
                disabled={isBusy}
                isLoading={activeAction === 'switch_method'}
                onClick={() => handleSwitchMethod(method)}
              >
                {tp(`switch_to_${method}` as Parameters<typeof tp>[0])}
              </Button>
            ))}
          </div>
        )}

        {/* Order modification buttons — vertical stack */}
        <div className="space-y-2">
          {canAmend && (
            <Button variant="secondary" size="md" className="w-full" disabled={isBusy} onClick={() => setAmendOpen(true)}>
              {t('modify_order')}
            </Button>
          )}
          {canSwitchType && (
            <Button variant="secondary" size="md" className="w-full" disabled={isBusy} onClick={() => setTypeOpen(true)}>
              {switchTypeLabel}
            </Button>
          )}
        </div>

        {/* Cancel — visually separated with spacing */}
        {canCancel && (
          <div className="mt-6">
            <Button variant="danger" size="md" className="w-full" disabled={isBusy} isLoading={activeAction === 'cancel'} onClick={() => { setCancelNotice(''); setCancelOpen(true) }}>
              {t('cancel_action')}
            </Button>
          </div>
        )}
      </div>

      {/* Cancel confirmation modal */}
      <Modal isOpen={cancelOpen} onClose={() => { setCancelOpen(false); setCancelConfirm(null); setCancelNotice('') }} title={t('cancel_confirm_title')} footer={cancelFooter}>
        {cancelConfirm ? (
          // BKL-146/FE-D19 — step-2: restate the KERNEL's prompt VERBATIM. The
          // fact of what will happen (paid → refund) comes from the kernel's
          // parked decision, never app-authored copy.
          <p className="text-sm text-smoke-600 mb-2" role="status" data-testid="cancel-kernel-prompt">{cancelConfirm.prompt}</p>
        ) : (
          <>
            <p className="text-sm text-smoke-600 mb-2">{t('cancel_confirm_body')}</p>
            <p className="text-xs text-smoke-400">{t('cancel_refund_note')}</p>
          </>
        )}
        {cancelNotice && (
          <p className="text-xs text-accent-red mt-3" role="status">{cancelNotice}</p>
        )}
      </Modal>

      {/* Amendment dialog */}
      {canAmend && items && (
        <AmendOrderDialog
          orderId={orderId}
          items={items}
          fulfillmentStatus={fulfillmentStatus}
          isOpen={amendOpen}
          onClose={() => setAmendOpen(false)}
          onMutate={onMutate}
        />
      )}

      {/* Order type switch dialog */}
      {canSwitchType && (
        <SwitchTypeDialog
          orderId={orderId}
          currentType={orderType ?? 'delivery'}
          isOpen={typeOpen}
          onClose={() => setTypeOpen(false)}
          onMutate={onMutate}
        />
      )}
    </>
  )
}
