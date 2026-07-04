'use client'

import { useTranslations } from 'next-intl'
import { useSpecials, toSpecialsDisplay } from '@/domains/specials'
import { Container, Text } from '@/components/atoms'

/**
 * Today's daily-specials strip (NEW-038 (b)) — surfaces the DailySpecial rows a
 * manager authors via the admin surface (NEW-005) on the public home page, over
 * the public read GET /api/specials/today (NEW-038 (a)).
 *
 * SAFE-BY-CONSTRUCTION: renders NOTHING (`null`) when there are no active
 * specials. The DailySpecial table is empty until a manager authors one, so this
 * is invisible — zero visual change on current data — and only appears once a
 * special exists (progressive enhancement, opt-in by the manager). The
 * promo-price BRL formatting + empty-safety live in the unit-tested
 * `toSpecialsDisplay` mapper; this component is a thin presentational wrapper.
 */
export function HomeSpecials() {
  const { data } = useSpecials()
  const t = useTranslations('home')
  const specials = toSpecialsDisplay(data)

  if (specials.length === 0) return null

  return (
    <section className="bg-smoke-50">
      <Container size="xl" className="py-8 text-center">
        <Text className="text-micro uppercase tracking-editorial text-smoke-500 font-medium">
          {t('specials_label')}
        </Text>
        <ul className="mt-4 flex flex-wrap items-center justify-center gap-4">
          {specials.map((s) => (
            <li
              key={s.productId}
              className="rounded-lg border border-smoke-200/60 bg-white px-5 py-3 text-left"
            >
              {s.headline && (
                <span className="block font-display text-lg text-charcoal-800">{s.headline}</span>
              )}
              {s.promoPrice && (
                <span className="mt-1 block font-semibold text-brand-500 tabular-nums">
                  {s.promoPrice}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}
