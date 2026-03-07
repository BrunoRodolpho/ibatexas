'use client'

import { useTranslations } from 'next-intl'
import { Package } from 'lucide-react'
import { track } from '@/domains/analytics'

interface ComboBannerProps {
  /** Whether combo products exist in the catalog */
  hasComboProducts: boolean
  /** Whether any filters are currently active */
  hasActiveFilters: boolean
  /** Callback to apply the combo smart filter */
  onApplyComboFilter: () => void
}

/**
 * Promotional banner for combo/bundle products.
 * Shown on the menu page when combos are available and no filters are active.
 */
export function ComboBanner({ hasComboProducts, hasActiveFilters, onApplyComboFilter }: ComboBannerProps) {
  const t = useTranslations()

  if (!hasComboProducts || hasActiveFilters) return null

  const handleClick = () => {
    track('combo_banner_clicked', {})
    onApplyComboFilter()
  }

  return (
    <section className="mb-4">
      <div className="surface-card rounded-card overflow-hidden">
        <div className="flex items-center gap-4 p-5 sm:p-6">
          {/* Icon */}
          <div className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center flex-shrink-0">
            <Package className="w-6 h-6 text-brand-500" strokeWidth={1.5} />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-display-2xs font-semibold text-charcoal-900 tracking-display">
              {t('combo_banner.title')}
            </h3>
            <p className="mt-0.5 text-xs text-smoke-400">
              {t('combo_banner.subtitle')}
            </p>
          </div>

          {/* CTA */}
          <button
            onClick={handleClick}
            className="flex-shrink-0 bg-brand-500 text-white text-xs font-semibold px-4 py-2 rounded-sm hover:bg-brand-600 active:scale-95 transition-all duration-300 ease-luxury"
          >
            {t('combo_banner.cta')}
          </button>
        </div>
      </div>
    </section>
  )
}
