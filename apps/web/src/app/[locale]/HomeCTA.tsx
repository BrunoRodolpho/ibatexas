'use client'

import { useTranslations } from 'next-intl'
import { ArrowRight } from 'lucide-react'
import { LinkButton } from '@/components/atoms'
import { useUIStore } from '@/domains/ui'

/**
 * Hero / closing CTA pair.
 *
 * The chat CTA used to be a `secondary` Button at full size — visually equal
 * to the primary "Ver Cardápio" action, which created a "what should I click?"
 * dual-CTA problem. It's now a tertiary text-link with an arrow, leaving the
 * brand-colored button as the unambiguous primary action.
 */
export default function HomeCTA() {
  const t = useTranslations()
  const setChat = useUIStore((s) => s.setChat)

  return (
    <div className="mt-8 flex flex-row items-center justify-center lg:justify-start gap-5">
      <LinkButton href="/search" variant="brand" size="md">
        {t('home.cta_button_menu')}
      </LinkButton>
      <button
        type="button"
        onClick={() => setChat(true)}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-charcoal-700 hover:text-charcoal-900 transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-smoke-50 rounded-sm"
      >
        {t('home.cta_button_ai')}
        <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
      </button>
    </div>
  )
}
