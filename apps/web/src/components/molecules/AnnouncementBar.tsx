'use client'

import { useTranslations } from 'next-intl'
import { MarqueeStrip } from '../atoms'

/**
 * Persistent announcement ticker strip.
 *
 * Shows operational info (delivery hours, free-shipping threshold)
 * in a thin, slow-scrolling marquee below the header. Uses the
 * `home.announcement` translation key with conditions note.
 */
export function AnnouncementBar() {
  const t = useTranslations('home')

  const content = (
    <span className="inline-flex items-center gap-6 px-6 text-[11px] text-smoke-500 tracking-wide">
      <span>{t('announcement')}</span>
      <span className="text-smoke-300" aria-hidden>·</span>
      <span>{t('announcement')}</span>
      <span className="text-smoke-300" aria-hidden>·</span>
    </span>
  )

  return (
    <div className="bg-smoke-100 border-b border-smoke-200/40">
      <MarqueeStrip speed={50} pauseOnHover={false} className="py-1">
        {content}
      </MarqueeStrip>
    </div>
  )
}
