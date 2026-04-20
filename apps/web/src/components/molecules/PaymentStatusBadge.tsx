'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@ibatexas/ui/atoms'

/**
 * Maps payment status to Badge variant.
 * Follows the existing 3-tier badge hierarchy from Badge.tsx.
 */
function getVariant(status: string) {
  switch (status) {
    case 'paid':
      return 'success'
    case 'awaiting_payment':
    case 'payment_pending':
    case 'cash_pending':
    case 'switching_method':
      return 'warning'
    case 'payment_expired':
    case 'payment_failed':
    case 'canceled':
      return 'danger'
    case 'refunded':
    case 'partially_refunded':
    case 'disputed':
    case 'waived':
      return 'default'
    default:
      return 'default'
  }
}

interface PaymentStatusBadgeProps {
  readonly status: string
  readonly className?: string
}

export function PaymentStatusBadge({ status, className }: PaymentStatusBadgeProps) {
  const t = useTranslations('payment')

  // i18n key = status_{paymentStatus}
  const key = `status_${status}` as Parameters<typeof t>[0]
  const label = t.has(key) ? t(key) : status

  return (
    <Badge variant={getVariant(status)} className={className}>
      {label}
    </Badge>
  )
}
