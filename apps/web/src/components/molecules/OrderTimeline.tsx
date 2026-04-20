'use client'

import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'

const STEP_KEYS = ['pending', 'confirmed', 'preparing', 'ready', 'in_delivery', 'delivered'] as const

function getCircleClass(isPast: boolean, isCurrent: boolean): string {
  if (isPast) return 'bg-accent-green text-white'
  if (isCurrent) return 'bg-brand-500 text-white animate-pulse'
  return 'bg-smoke-200 text-[var(--color-text-disabled)]'
}

function getLabelClass(isPast: boolean, isCurrent: boolean): string {
  if (isCurrent) return 'text-charcoal-900 font-semibold'
  if (isPast) return 'text-charcoal-700'
  return 'text-[var(--color-text-muted)]'
}

interface OrderTimelineProps {
  readonly status: string
  readonly deliveryType?: "pickup" | "delivery" | "dine_in"
}

export function OrderTimeline({ status, deliveryType }: OrderTimelineProps) {
  const t = useTranslations('order')
  const isCanceled = status === 'canceled'

  if (isCanceled) {
    return (
      <div className="flex items-center gap-2 text-sm text-accent-red font-medium">
        <div className="w-6 h-6 rounded-full bg-accent-red/10 flex items-center justify-center">
          <span className="text-accent-red text-xs">✕</span>
        </div>
        {t('timeline_canceled')}
      </div>
    )
  }

  const steps =
    deliveryType === "pickup" || deliveryType === "dine_in"
      ? STEP_KEYS.filter(k => k !== "in_delivery")
      : [...STEP_KEYS]

  const ALL_LABEL_KEYS: Record<typeof STEP_KEYS[number], string> = {
    pending: 'timeline_pending',
    confirmed: 'timeline_confirmed',
    preparing: 'timeline_preparing',
    ready: 'timeline_ready',
    in_delivery: 'timeline_in_delivery',
    delivered: 'timeline_delivered',
  }

  const rawIndex = steps.indexOf(status as typeof steps[number])
  const currentIndex = rawIndex >= 0 ? rawIndex : 0

  return (
    <div className="space-y-0">
      {steps.map((stepKey, i) => {
        const isPast = i < currentIndex
        const isCurrent = i === currentIndex

        const circleClass = getCircleClass(isPast, isCurrent)
        const labelClass = getLabelClass(isPast, isCurrent)

        return (
          <div key={stepKey} className="flex items-start gap-3">
            {/* Vertical line + circle */}
            <div className="flex flex-col items-center">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${circleClass}`}
              >
                {isPast ? (
                  <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                ) : (
                  <span className="text-micro font-semibold">{i + 1}</span>
                )}
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`w-px h-6 ${isPast ? 'bg-accent-green' : 'bg-smoke-200'}`}
                />
              )}
            </div>

            {/* Label */}
            <p className={`text-sm pt-0.5 ${labelClass}`}>
              {t(ALL_LABEL_KEYS[stepKey])}
            </p>
          </div>
        )
      })}
    </div>
  )
}
