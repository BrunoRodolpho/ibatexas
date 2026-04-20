'use client'

import { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@ibatexas/ui/atoms'
import { Modal } from '@ibatexas/ui/molecules'
import { apiFetch } from '@/lib/api'
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
    // Keep modal open during request — close only on success/failure
    setActiveAction('cancel')
    setErrorMsg('')
    try {
      await apiFetch(`/api/orders/${orderId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setCancelOpen(false)
      onMutate()
    } catch {
      setErrorMsg(t('cancel_error'))
    } finally {
      setActiveAction(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

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
  const switchTypeLabel = orderType === 'delivery'
    ? t('switch_type_to_pickup')
    : orderType === 'pickup'
      ? t('switch_type_to_delivery')
      : t('switch_type_to_dine_in')

  // Available payment method switch targets (exclude current)
  const switchTargets = ['pix', 'card', 'cash'].filter((m) => m !== paymentMethod)

  // Cancel modal footer
  const cancelFooter = (
    <div className="flex gap-2 justify-end">
      <Button variant="secondary" size="sm" disabled={activeAction === 'cancel'} onClick={() => setCancelOpen(false)}>
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
            <Button variant="danger" size="md" className="w-full" disabled={isBusy} isLoading={activeAction === 'cancel'} onClick={() => setCancelOpen(true)}>
              {t('cancel_action')}
            </Button>
          </div>
        )}
      </div>

      {/* Cancel confirmation modal */}
      <Modal isOpen={cancelOpen} onClose={() => setCancelOpen(false)} title={t('cancel_confirm_title')} footer={cancelFooter}>
        <p className="text-sm text-smoke-600 mb-2">{t('cancel_confirm_body')}</p>
        <p className="text-xs text-smoke-400">{t('cancel_refund_note')}</p>
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
