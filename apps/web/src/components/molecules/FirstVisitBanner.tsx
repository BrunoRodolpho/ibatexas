'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight, Loader2, X } from 'lucide-react'
import { Button } from '../atoms'
import { useRouter } from '@/i18n/navigation'
import { useFirstVisit } from '@/domains/session/useFirstVisit'

/**
 * First-visit promotional banner.
 *
 * Audit P1-1: previously rendered 3 competing CTAs (primary + external
 * WhatsApp link + dismiss text button), which ate >15% of mobile viewport
 * and split attention. Simplified to a single primary CTA + a dismiss X.
 * The WhatsApp CTA lives in the header/footer already — no need to
 * duplicate it here.
 *
 * Primary CTA uses useTransition so the button visibly enters a pending
 * state during navigation (spinner + disabled), restoring the click
 * acknowledgment users were missing from the previous silent LinkButton.
 */
export function FirstVisitBanner() {
  const t = useTranslations('first_visit')
  const { isFirstVisit, dismiss } = useFirstVisit()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!isFirstVisit) return null

  function handlePrimaryClick() {
    startTransition(() => {
      router.push('/search?q=kit')
    })
  }

  return (
    <div className="relative bg-brand-50 border border-brand-200 rounded-sm p-4 mb-6 animate-reveal">
      <button
        onClick={dismiss}
        className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center text-[var(--color-text-secondary)] hover:text-charcoal-900 transition-colors focus-brand rounded-full"
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
    </div>
  )
}
