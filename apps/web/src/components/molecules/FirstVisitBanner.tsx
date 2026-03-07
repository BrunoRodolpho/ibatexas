'use client'

import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { LinkButton } from '../atoms/Button'
import { useFirstVisit } from '@/domains/session/useFirstVisit'

export function FirstVisitBanner() {
  const t = useTranslations('first_visit')
  const { isFirstVisit, dismiss } = useFirstVisit()

  if (!isFirstVisit) return null

  return (
    <div className="relative bg-brand-50 border border-brand-200 rounded-sm p-4 mb-6 animate-reveal">
      <button
        onClick={dismiss}
        className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center text-smoke-400 hover:text-charcoal-900 transition-colors"
        aria-label={t('dismiss')}
      >
        <X className="w-4 h-4" />
      </button>

      <p className="font-display text-sm font-semibold text-charcoal-900 mb-1">
        {t('title')}
      </p>
      <p className="text-xs text-smoke-400 mb-3 pr-8">
        {t('body')}
      </p>
      <div className="flex items-center gap-3">
        <LinkButton href="/search?q=kit" variant="brand" size="sm">
          {t('cta')}
        </LinkButton>
        <button
          onClick={dismiss}
          className="text-xs text-smoke-400 hover:text-charcoal-900 transition-colors"
        >
          {t('dismiss')}
        </button>
      </div>
    </div>
  )
}
