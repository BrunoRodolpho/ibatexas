'use client'

import { useTranslations } from 'next-intl'
import { CalendarDays } from 'lucide-react'

export default function ReservasPage() {
  const t = useTranslations('admin')
  return (
    <div className="flex h-full min-h-[400px] items-center justify-center">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100">
          <CalendarDays className="h-8 w-8 text-slate-400" />
        </div>
        <h2 className="text-xl font-bold text-slate-900">{t('reservations')}</h2>
        <p className="mt-2 text-sm text-slate-500">{t('coming_soon_description')}</p>
        <span className="mt-4 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
          {t('coming_soon')}
        </span>
      </div>
    </div>
  )
}
