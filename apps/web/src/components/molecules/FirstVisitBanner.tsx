'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight, Loader2, X } from 'lucide-react'
import { Button } from '../atoms'
import { useRouter } from '@/i18n/navigation'
import { useFirstVisit } from '@/domains/session/useFirstVisit'
import { track } from '@/domains/analytics/track'

// `track` is still used by the WhatsApp click handler below.

/**
 * First-visit promotional banner.
 *
 * The primary CTA used to be a LinkButton labeled "Ver Cardápio" — a silent
 * navigation with no feedback. Users perceived it as broken ("clicked Add and
 * nothing happened"). It now uses `useTransition` so the button visibly enters
 * a pending state during navigation, with a spinner and disabled state — the
 * click acknowledgment users were missing.
 */
export function FirstVisitBanner() {
  const t = useTranslations('first_visit')
  const { isFirstVisit, dismiss } = useFirstVisit()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!isFirstVisit) return null

  const whatsappNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '5500000000000'
  const whatsappMessage = encodeURIComponent('Ola! Quero meu desconto de R$15 no primeiro pedido!')
  const whatsappHref = `https://wa.me/${whatsappNumber}?text=${whatsappMessage}`

  function handleWhatsAppClick() {
    track('whatsapp_cta_clicked', { source: 'first_visit_banner' })
  }

  function handlePrimaryClick() {
    // No analytics event yet — adding one would require updating the
    // AnalyticsEvent union + dashboard docs (CLAUDE.md rule #8). Out of scope
    // for the visual-feedback fix; revisit when wiring acquisition funnel.
    startTransition(() => {
      router.push('/search?q=kit')
    })
  }

  return (
    <div className="relative bg-brand-50 border border-brand-200 rounded-sm p-4 mb-6 animate-reveal">
      <button
        onClick={dismiss}
        className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center text-[var(--color-text-secondary)] hover:text-charcoal-900 transition-colors"
        aria-label={t('dismiss')}
      >
        <X className="w-4 h-4" />
      </button>

      <p className="text-sm font-semibold text-charcoal-900 mb-1">
        {t('title')}
      </p>
      <p className="text-xs text-[var(--color-text-secondary)] mb-3 pr-8">
        {t('body')}
      </p>
      <div className="flex items-center gap-3">
        <Button
          variant="brand"
          size="sm"
          onClick={handlePrimaryClick}
          disabled={isPending}
          aria-busy={isPending}
        >
          {isPending ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2.5} />
              {t('cta')}
            </>
          ) : (
            <>
              {t('cta')}
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={2.5} />
            </>
          )}
        </Button>
        <a
          href={whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleWhatsAppClick}
          className="text-xs font-medium text-brand-600 hover:text-brand-800 underline underline-offset-2 transition-colors"
        >
          {t('whatsapp_cta')}
        </a>
        <button
          onClick={dismiss}
          className="text-xs text-[var(--color-text-secondary)] hover:text-charcoal-900 transition-colors"
        >
          {t('dismiss')}
        </button>
      </div>
    </div>
  )
}
