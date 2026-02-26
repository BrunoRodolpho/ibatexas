'use client'

import { useTranslations } from 'next-intl'
import { MapPin } from 'lucide-react'

export default function ZonasPage() {
  const t = useTranslations('admin')
  return (
    <div className="flex h-full min-h-[400px] items-center justify-center">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-sm bg-smoke-100">
          <MapPin className="h-8 w-8 text-smoke-300" />
        </div>
        <h2 className="text-xl font-bold text-charcoal-900">{t('delivery_zones')}</h2>
        <p className="mt-2 text-sm text-smoke-400">{t('coming_soon_description')}</p>
        <span className="mt-4 inline-block rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-700">
          {t('coming_soon')}
        </span>
      </div>
    </div>
  )
}
