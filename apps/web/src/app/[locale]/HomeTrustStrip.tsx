'use client'

import { useTranslations } from 'next-intl'
import { Thermometer, Shield, Truck, Clock } from 'lucide-react'

/**
 * Horizontal trust-signal strip — delivery promise badges adapted
 * for the homepage (horizontal row instead of PDP's vertical stack).
 */
export function HomeTrustStrip() {
  const t = useTranslations('delivery_promise')

  const badges = [
    { icon: Thermometer, textKey: 'thermal' as const },
    { icon: Shield, textKey: 'vacuum_sealed' as const },
    { icon: Truck, textKey: 'refrigerated' as const },
    { icon: Clock, textKey: 'delivery_time' as const },
  ]

  return (
    <section className="bg-smoke-50">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-4">
        <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-8">
          {badges.map(({ icon: Icon, textKey }) => (
            <div key={textKey} className="flex items-center gap-2 text-xs text-smoke-500">
              <Icon className="w-4 h-4 text-smoke-400 flex-shrink-0" strokeWidth={1.5} />
              <span>{t(textKey)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
