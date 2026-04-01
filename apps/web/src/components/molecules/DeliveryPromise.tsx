'use client'

import { useTranslations } from 'next-intl'
import { Thermometer, Shield, Truck, Clock } from 'lucide-react'

interface DeliveryPromiseProps {
  readonly availabilityWindow?: string
}

export function DeliveryPromise({ availabilityWindow }: DeliveryPromiseProps) {
  const t = useTranslations('delivery_promise')
  const showSameDay = availabilityWindow === 'SEMPRE' || availabilityWindow === 'CONGELADOS'

  const promises = [
    { icon: Thermometer, textKey: 'thermal' as const },
    { icon: Shield, textKey: 'vacuum_sealed' as const },
    { icon: Truck, textKey: 'refrigerated' as const },
  ]

  return (
    <div className="border border-smoke-200 rounded-sm p-4 bg-smoke-50 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)]">
        {t('title')}
      </h3>
      <ul className="space-y-2.5">
        {promises.map(({ icon: Icon, textKey }) => (
          <li key={textKey} className="flex items-start gap-2.5 text-xs text-charcoal-700">
            <Icon className="w-4 h-4 text-[var(--color-text-secondary)] mt-0.5 flex-shrink-0" strokeWidth={1.5} />
            <span>{t(textKey)}</span>
          </li>
        ))}
        {showSameDay && (
          <li className="flex items-start gap-2.5 text-xs text-charcoal-700">
            <Clock className="w-4 h-4 text-[var(--color-text-secondary)] mt-0.5 flex-shrink-0" strokeWidth={1.5} />
            <span>{t('same_day')}</span>
          </li>
        )}
      </ul>
    </div>
  )
}
