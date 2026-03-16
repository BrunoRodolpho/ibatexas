'use client'

import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'

const STEP_KEYS = ['pending', 'processing', 'shipped', 'delivered'] as const

function getCircleClass(isPast: boolean, isCurrent: boolean): string {
  if (isPast) return 'bg-accent-green text-white'
  if (isCurrent) return 'bg-brand-500 text-white animate-pulse'
  return 'bg-smoke-200 text-smoke-400'
}

function getLabelClass(isPast: boolean, isCurrent: boolean): string {
  if (isCurrent) return 'text-charcoal-900 font-semibold'
  if (isPast) return 'text-charcoal-700'
  return 'text-smoke-400'
}

interface OrderTimelineProps {
  readonly status: string
}

export function OrderTimeline({ status }: OrderTimelineProps) {
  const t = useTranslations('order')
  const currentIndex = STEP_KEYS.indexOf(status as typeof STEP_KEYS[number])
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

  const labelKeys = [
    'timeline_pending',
    'timeline_processing',
    'timeline_shipped',
    'timeline_delivered',
  ] as const

  return (
    <div className="space-y-0">
      {STEP_KEYS.map((stepKey, i) => {
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
                  <span className="text-[10px] font-semibold">{i + 1}</span>
                )}
              </div>
              {i < STEP_KEYS.length - 1 && (
                <div
                  className={`w-px h-6 ${isPast ? 'bg-accent-green' : 'bg-smoke-200'}`}
                />
              )}
            </div>

            {/* Label */}
            <p className={`text-sm pt-0.5 ${labelClass}`}>
              {t(labelKeys[i])}
            </p>
          </div>
        )
      })}
    </div>
  )
}
