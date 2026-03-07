'use client'

import { Flame } from 'lucide-react'
import { useTranslations } from 'next-intl'

/**
 * Emotional story block — brand storytelling between menu sections.
 * Elevates brand perception and differentiates from commodity platforms.
 */
export function StoryBlock({ compact = false }: { compact?: boolean }) {
  const t = useTranslations()

  if (compact) {
    return (
      <div className="relative overflow-hidden">
        <div className="py-2 sm:py-4">
          <div className="max-w-lg mx-auto text-center relative z-10">
            {/* Flame icon */}
            <div className="flex justify-center mb-3">
              <div className="h-10 w-10 rounded-full bg-brand-500/30 flex items-center justify-center">
                <Flame className="w-5 h-5 text-brand-400" strokeWidth={2} />
              </div>
            </div>
            <h2 className="font-display text-display-xs sm:text-display-sm font-semibold text-smoke-50 tracking-display mb-3">
              {t('story.title')}
            </h2>
            <p className="font-display italic text-smoke-300 text-base sm:text-lg leading-relaxed mb-1.5">
              {t('story.body_1')}
            </p>
            <p className="font-display italic text-smoke-400 text-sm sm:text-base leading-relaxed">
              {t('story.body_2')}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <section className="relative my-12 lg:my-16 overflow-hidden rounded-card border-l-4 border-brand-500">
      <div className="surface-inverted grain-overlay px-6 sm:px-10 py-10 sm:py-14">
        <div className="max-w-lg mx-auto text-center relative z-10">
          {/* Flame icon */}
          <div className="flex justify-center mb-4">
            <div className="h-10 w-10 rounded-full bg-brand-500/30 flex items-center justify-center">
              <Flame className="w-5 h-5 text-brand-400" strokeWidth={2} />
            </div>
          </div>

          {/* Editorial headline */}
          <h2 className="font-display text-display-xs sm:text-display-sm font-semibold text-smoke-50 tracking-display mb-4">
            {t('story.title')}
          </h2>

          {/* Body */}
          <p className="font-display italic text-smoke-300 text-base sm:text-lg leading-relaxed mb-2">
            {t('story.body_1')}
          </p>
          <p className="font-display italic text-smoke-400 text-sm sm:text-base leading-relaxed">
            {t('story.body_2')}
          </p>

          {/* Decorative divider */}
          <div className="mt-6 flex items-center justify-center gap-3">
            <div className="h-px w-8 bg-smoke-600" />
            <span className="text-[10px] uppercase tracking-editorial text-smoke-500 font-medium">
              {t('story.tagline')}
            </span>
            <div className="h-px w-8 bg-smoke-600" />
          </div>
        </div>
      </div>
    </section>
  )
}
