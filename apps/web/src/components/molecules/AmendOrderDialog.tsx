'use client'

import { useState, useMemo, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@ibatexas/ui/atoms'
import { Modal } from '@ibatexas/ui/molecules'
import { apiFetch } from '@/lib/api'
import type { OrderActionItem } from './OrderActions'

interface AmendOrderDialogProps {
  readonly orderId: string
  readonly items: OrderActionItem[]
  readonly fulfillmentStatus: string
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly onMutate: () => void
}

type Step = 'edit' | 'review'
type SubmitState = 'idle' | 'loading' | 'error'

function formatBRL(centavos: number): string {
  const sign = centavos < 0 ? '−' : '+'
  const abs = Math.abs(centavos)
  return `${sign}R$ ${(abs / 100).toFixed(2).replace('.', ',')}`
}

export function AmendOrderDialog({ orderId, items, fulfillmentStatus, isOpen, onClose, onMutate }: AmendOrderDialogProps) {
  const t = useTranslations('order')

  const [step, setStep] = useState<Step>('edit')
  const [submitState, setSubmitState] = useState<SubmitState>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  // Local edit state — no API calls until commit
  const [quantities, setQuantities] = useState<Map<string, number>>(() => new Map(items.map(i => [i.id, i.quantity])))
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set())
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null)

  const isPreparing = fulfillmentStatus === 'preparing'

  // Reset state when dialog opens/closes
  const handleClose = useCallback(() => {
    setStep('edit')
    setSubmitState('idle')
    setErrorMsg('')
    setQuantities(new Map(items.map(i => [i.id, i.quantity])))
    setRemovedIds(new Set())
    setConfirmingRemoveId(null)
    onClose()
  }, [items, onClose])

  // ── Edit step helpers ──────────────────────────────────────────────────

  function isItemLocked(item: OrderActionItem): boolean {
    return isPreparing && item.productType === 'food'
  }

  function updateQty(itemId: string, newQty: number) {
    if (newQty < 1) return
    setQuantities(prev => new Map(prev).set(itemId, newQty))
  }

  function confirmRemove(itemId: string) {
    setConfirmingRemoveId(itemId)
  }

  function executeRemove(itemId: string) {
    setRemovedIds(prev => new Set(prev).add(itemId))
    setConfirmingRemoveId(null)
  }

  function cancelRemove() {
    setConfirmingRemoveId(null)
  }

  // ── Diff calculation ───────────────────────────────────────────────────

  const changes = useMemo(() => {
    const result: Array<{
      type: 'remove' | 'update_qty'
      item: OrderActionItem
      originalQty: number
      newQty: number
      priceDelta: number
    }> = []

    for (const item of items) {
      if (removedIds.has(item.id)) {
        result.push({
          type: 'remove',
          item,
          originalQty: item.quantity,
          newQty: 0,
          priceDelta: -(item.unit_price * item.quantity),
        })
      } else {
        const newQty = quantities.get(item.id) ?? item.quantity
        if (newQty !== item.quantity) {
          result.push({
            type: 'update_qty',
            item,
            originalQty: item.quantity,
            newQty,
            priceDelta: item.unit_price * (newQty - item.quantity),
          })
        }
      }
    }

    return result
  }, [items, quantities, removedIds])

  const hasChanges = changes.length > 0

  // All items removed = this is a cancellation, not an amendment
  const isFullCancellation = removedIds.size === items.length

  const previousSubtotal = useMemo(() => items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0), [items])

  const totalDelta = useMemo(() => changes.reduce((sum, c) => sum + c.priceDelta, 0), [changes])

  const newSubtotal = previousSubtotal + totalDelta

  // ── Submit ─────────────────────────────────────────────────────────────

  async function handleSubmit() {
    setSubmitState('loading')
    setErrorMsg('')

    try {
      if (isFullCancellation) {
        // All items removed — cancel the order instead of amending
        await apiFetch(`/api/orders/${orderId}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Todos os itens removidos pelo cliente' }),
        })
      } else {
        // Atomic batch — all changes validated and applied together
        const batchChanges = changes.map((c) => ({
          type: c.type,
          itemTitle: c.item.title,
          ...(c.type === 'update_qty' ? { quantity: c.newQty } : {}),
        }))

        await apiFetch(`/api/orders/${orderId}/amend/batch`, {
          method: 'POST',
          body: JSON.stringify({ changes: batchChanges }),
        })
      }

      onMutate()
      handleClose()
    } catch (err) {
      const errObj = err as { code?: string; error?: string }
      if (errObj?.code === 'ITEM_NOW_LOCKED') {
        setErrorMsg(t('amend_conflict'))
        setStep('edit')
        onMutate() // refresh order state
      } else if (errObj?.code === 'ALL_ITEMS_REMOVED') {
        setErrorMsg(errObj.error ?? t('amend_cancel_warning'))
      } else if (errObj?.code === 'PONR_EXPIRED') {
        setErrorMsg(t('cancel_ponr_expired') ?? 'O prazo para cancelamento expirou.')
      } else {
        setErrorMsg(t('amend_error'))
      }
      setSubmitState('idle')
    }
  }

  // ── Footer content ─────────────────────────────────────────────────────

  const editFooter = (
    <div className="flex gap-2 justify-between">
      <Button variant="secondary" size="sm" onClick={handleClose}>
        {t('dialog_cancel')}
      </Button>
      <Button variant="primary" size="sm" disabled={!hasChanges} onClick={() => setStep('review')}>
        {t('amend_review')} →
      </Button>
    </div>
  )

  const reviewFooter = (
    <div className="flex gap-2 justify-between">
      <Button variant="secondary" size="sm" onClick={() => setStep('edit')}>
        ← {t('dialog_back')}
      </Button>
      <Button variant={isFullCancellation ? 'danger' : 'primary'} size="sm" isLoading={submitState === 'loading'} onClick={handleSubmit}>
        {isFullCancellation ? t('cancel_order') : t('amend_confirm')}
      </Button>
    </div>
  )

  // ── Visible (non-removed) items for edit step ──────────────────────────
  const visibleItems = items.filter(i => !removedIds.has(i.id))

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('modify_dialog_title')}
      size="md"
      footer={step === 'edit' ? editFooter : reviewFooter}
    >
      {errorMsg && (
        <p className="text-xs text-accent-red mb-3">{errorMsg}</p>
      )}

      {/* ── Edit Step ──────────────────────────────────────────────── */}
      {step === 'edit' && (
        <div className="space-y-1">
          {visibleItems.map((item) => {
            const locked = isItemLocked(item)
            const currentQty = quantities.get(item.id) ?? item.quantity
            const isConfirmingRemove = confirmingRemoveId === item.id

            return (
              <div key={item.id} className={`py-3 border-b border-smoke-100 last:border-0 ${locked ? 'opacity-50' : ''}`}>
                {/* Line 1: Title + lock badge */}
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-sm font-medium text-charcoal-900 flex-1">{item.title}</p>
                  {locked && (
                    <span className="text-micro uppercase tracking-wide text-brand-500 bg-brand-50 px-2 py-0.5 rounded-sm" title={t('amend_item_locked_hint')}>
                      {t('amend_item_locked')}
                    </span>
                  )}
                </div>

                {/* Line 2: Controls (or locked hint) */}
                {locked ? (
                  <p className="text-xs text-smoke-400">{t('amend_item_locked_hint')}</p>
                ) : isConfirmingRemove ? (
                  // Inline remove confirmation
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-accent-red">{t('amend_remove_confirm')}</span>
                    <Button variant="danger" size="sm" onClick={() => executeRemove(item.id)}>
                      Sim
                    </Button>
                    <Button variant="secondary" size="sm" onClick={cancelRemove}>
                      Não
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="sm" disabled={currentQty <= 1} onClick={() => updateQty(item.id, currentQty - 1)}>
                        −
                      </Button>
                      <span className="text-sm font-medium w-8 text-center">{currentQty}</span>
                      <Button variant="secondary" size="sm" onClick={() => updateQty(item.id, currentQty + 1)}>
                        +
                      </Button>
                    </div>
                    <button type="button" onClick={() => confirmRemove(item.id)} className="text-xs text-accent-red/70 hover:text-accent-red underline underline-offset-2 transition-colors">
                      {t('amend_remove')}
                    </button>
                  </div>
                )}
              </div>
            )
          })}

          {visibleItems.length === 0 && (
            <p className="text-sm text-smoke-400 text-center py-4">{t('amend_no_changes')}</p>
          )}
        </div>
      )}

      {/* ── Review Step ────────────────────────────────────────────── */}
      {step === 'review' && (
        <div className="space-y-4">
          {/* Change list */}
          <div className="space-y-2">
            {changes.map((change) => (
              <div key={change.item.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  {change.type === 'remove' ? (
                    <span className="text-accent-red text-xs font-medium">−</span>
                  ) : (
                    <span className="text-smoke-400 text-xs font-medium">↻</span>
                  )}
                  <span className="text-charcoal-700">
                    {change.item.title}
                    {change.type === 'update_qty' && (
                      <span className="text-smoke-400"> x{change.originalQty} → x{change.newQty}</span>
                    )}
                    {change.type === 'remove' && (
                      <span className="text-smoke-400 ml-1">{t('amend_removed')}</span>
                    )}
                  </span>
                </div>
                <span className={change.priceDelta < 0 ? 'text-accent-red' : 'text-accent-green'}>
                  {formatBRL(change.priceDelta)}
                </span>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="border-t border-smoke-200 pt-3 space-y-1">
            <div className="flex justify-between text-sm text-smoke-400">
              <span>{t('amend_diff_previous')}</span>
              <span>R$ {(previousSubtotal / 100).toFixed(2).replace('.', ',')}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold text-charcoal-900">
              <span>{t('amend_diff_new')}</span>
              <span>R$ {(newSubtotal / 100).toFixed(2).replace('.', ',')}</span>
            </div>
            <div className={`flex justify-between text-sm font-medium ${totalDelta < 0 ? 'text-accent-red' : 'text-accent-green'}`}>
              <span>{t('amend_diff_delta')}</span>
              <span>{formatBRL(totalDelta)}</span>
            </div>
          </div>

          {/* Full cancellation warning or recalculation note */}
          {isFullCancellation ? (
            <p className="text-xs text-accent-red font-medium">{t('amend_cancel_warning') ?? 'Todos os itens serão removidos e o pedido será cancelado.'}</p>
          ) : (
            <p className="text-xs text-smoke-400">{t('amend_diff_recalc_note')}</p>
          )}
        </div>
      )}
    </Modal>
  )
}
