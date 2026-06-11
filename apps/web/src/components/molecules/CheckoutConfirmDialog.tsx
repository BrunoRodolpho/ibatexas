'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@ibatexas/ui/atoms'
import { Modal } from '@ibatexas/ui/molecules'

interface CheckoutConfirmDialogProps {
  readonly isOpen: boolean
  /** pt-BR prompt from the orders pack (e.g. "Confirmar pedido de R$ 1.500,00?"). */
  readonly prompt: string
  /** True while the confirm POST is in flight. */
  readonly loading: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/**
 * Large-ticket checkout confirmation. The HTTP checkout returns 202
 * REQUEST_CONFIRMATION for orders ≥ R$1.000; this dialog surfaces the
 * pack's pt-BR prompt and resumes (or abandons) the parked checkout.
 * Mirrors SwitchTypeDialog / AmendOrderDialog (shared Modal + footer Buttons).
 */
export function CheckoutConfirmDialog({
  isOpen,
  prompt,
  loading,
  onConfirm,
  onCancel,
}: CheckoutConfirmDialogProps) {
  const t = useTranslations('checkout')

  const footer = (
    <div className="flex gap-2 justify-end">
      <Button variant="secondary" size="sm" onClick={onCancel} disabled={loading}>
        {t('confirm_dialog_cancel')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        isLoading={loading}
        onClick={onConfirm}
      >
        {t('confirm_dialog_confirm')}
      </Button>
    </div>
  )

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={t('confirm_dialog_title')}
      footer={footer}
      size="sm"
    >
      <p className="text-sm text-charcoal-700">{prompt}</p>
    </Modal>
  )
}
