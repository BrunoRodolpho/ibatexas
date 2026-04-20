'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight, X } from 'lucide-react'
import { Button, MarqueeStrip } from '../atoms'
import { useRouter } from '@/i18n/navigation'
import { useFirstVisit } from '@/domains/session/useFirstVisit'
import { Link } from '@/i18n/navigation'

/**
 * Animated promo ticker — editorial marquee for first-time visitors.
 *
 * Replaces the old static FirstVisitBanner with a large, dramatic
 * infinitely scrolling marquee using display serif typography (Playfair).
 * Inspired by premium food brands like Amorino — the text is a
 * visual statement, not an info bar.
 *
 * Mobile: CTA button hides; the entire strip becomes a tappable link.
 */
export function PromoTicker() {
  const t = useTranslations('promo_ticker')
  const { isFirstVisit, dismiss } = useFirstVisit()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!isFirstVisit) return null

  function handlePrimaryClick() {
    startTransition(() => {
      router.push('/search?tags=kit')
    })
  }

  const segments = [
    { text: t('segment_discount'), accent: true },
    { text: t('segment_first'), accent: false },
    { text: t('segment_smoke'), accent: false },
    { text: t('segment_craft'), accent: false },
  ]

  const tickerContent = (
    <span className="inline-flex items-center">
      {segments.map((seg) => (
        <span key={seg.text} className="inline-flex items-center">
          <span
            className={`px-6 font-display italic text-2xl sm:text-3xl lg:text-4xl ${
              seg.accent ? 'text-brand-500' : 'text-charcoal-800'
            }`}
          >
            {seg.text}
          </span>
          <span className="text-brand-300 text-xl sm:text-2xl lg:text-3xl select-none" aria-hidden>
            ·
          </span>
        </span>
      ))}
    </span>
  )

  return (
    <div className="relative bg-white border-y border-smoke-200/60 animate-reveal">
      {/* Dismiss — top-right corner */}
      <button
        onClick={dismiss}
        className="absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center text-smoke-300 hover:text-charcoal-900 transition-colors focus-brand rounded-full"
        aria-label={t('dismiss')}
      >
        <X className="w-4 h-4" strokeWidth={2} />
      </button>

      {/* Marquee — display-sized text */}
      <div className="py-6 sm:py-8 lg:py-10">
        {/* Mobile: entire marquee is tappable */}
        <Link
          href="/search?tags=kit"
          className="block sm:hidden"
          aria-label={t('cta')}
        >
          <MarqueeStrip speed={35} aria-label={t('segment_discount')}>
            {tickerContent}
          </MarqueeStrip>
        </Link>

        {/* Desktop: marquee not tappable, separate CTA below */}
        <div className="hidden sm:block">
          <MarqueeStrip speed={35} aria-label={t('segment_discount')}>
            {tickerContent}
          </MarqueeStrip>
        </div>
      </div>

      {/* CTA row — below the marquee, centered */}
      <div className="hidden sm:flex items-center justify-center gap-3 pb-5">
        <Button
          variant="brand"
          size="md"
          onClick={handlePrimaryClick}
          disabled={isPending}
          aria-busy={isPending}
          isLoading={isPending}
        >
          {t('cta')}
          {!isPending && <ArrowRight className="w-4 h-4" strokeWidth={2.5} />}
        </Button>
        <span className="text-[10px] text-smoke-400 italic">
          {t('terms')}
        </span>
      </div>
    </div>
  )
}
