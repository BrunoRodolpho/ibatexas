'use client'

import { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@ibatexas/ui/atoms'
import { Modal } from '@ibatexas/ui/molecules'
import { apiFetch } from '@/lib/api'

interface SwitchTypeDialogProps {
  readonly orderId: string
  readonly currentType: string
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly onMutate: () => void
}

type ActionState = 'idle' | 'loading' | 'success' | 'error'

const TYPE_VALUES = ['delivery', 'pickup', 'dine_in'] as const

export function SwitchTypeDialog({ orderId, currentType, isOpen, onClose, onMutate }: SwitchTypeDialogProps) {
  const t = useTranslations('order')
  const [actionState, setActionState] = useState<ActionState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [selectedType, setSelectedType] = useState(currentType)

  const typeLabels: Record<string, string> = {
    delivery: t('switch_type_option_delivery'),
    pickup: t('switch_type_option_pickup'),
    dine_in: t('switch_type_option_dine_in'),
  }

  const handleSubmit = useCallback(async () => {
    if (selectedType === currentType) return
    setActionState('loading')
    setErrorMsg('')
    try {
      const result = await apiFetch(`/api/orders/${orderId}/type`, {
        method: 'PATCH',
        body: JSON.stringify({ type: selectedType }),
      }) as { paymentMethodChangeRequired?: boolean }

      if (result?.paymentMethodChangeRequired) {
        setErrorMsg(t('switch_type_cash_warning'))
      }

      setActionState('success')
      onMutate()
      onClose()
    } catch {
      setActionState('error')
      setErrorMsg(t('switch_type_error'))
    }
  }, [orderId, selectedType, currentType, onMutate, onClose, t])

  // Impact preview message
  const impactMessage = selectedType === 'delivery' && currentType !== 'delivery'
    ? t('switch_type_delivery_fee_add')
    : selectedType !== 'delivery' && currentType === 'delivery'
      ? t('switch_type_delivery_fee_remove')
      : null

  const footer = (
    <div className="flex gap-2 justify-end">
      <Button variant="secondary" size="sm" onClick={onClose}>
        {t('dialog_back')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        isLoading={actionState === 'loading'}
        disabled={selectedType === currentType}
        onClick={handleSubmit}
      >
        {t('dialog_confirm')}
      </Button>
    </div>
  )

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('switch_type')} footer={footer}>
      {actionState === 'error' && errorMsg && (
        <p className="text-xs text-accent-red mb-3">{errorMsg}</p>
      )}

      <div className="space-y-2">
        {TYPE_VALUES.map((value) => (
          <label
            key={value}
            className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
              selectedType === value
                ? 'border-brand-500 bg-brand-50'
                : 'border-smoke-200 hover:border-smoke-400'
            }`}
          >
            <input
              type="radio"
              name="orderType"
              value={value}
              checked={selectedType === value}
              onChange={() => setSelectedType(value)}
              className="accent-brand-500"
            />
            <span className="text-sm font-medium">{typeLabels[value]}</span>
            {value === currentType && (
              <span className="text-xs text-smoke-500 ml-auto">{t('switch_type_current_badge')}</span>
            )}
          </label>
        ))}
      </div>

      {/* Impact preview */}
      {impactMessage && (
        <p className="mt-3 text-xs text-smoke-500 bg-smoke-100 rounded-sm px-3 py-2">
          {impactMessage}
        </p>
      )}
    </Modal>
  )
}
