import clsx from 'clsx'

type SectionSpacing = 'tight' | 'default' | 'loose' | 'hero' | 'none'
type SectionBackground = 'default' | 'muted' | 'accent' | 'dark' | 'inverted'

interface SectionProps {
  readonly spacing?: SectionSpacing
  readonly background?: SectionBackground
  readonly id?: string
  readonly className?: string
  readonly children: React.ReactNode
}

/**
 * Standardized vertical-rhythm section.
 *
 * Pairs with `<Container>` for predictable page-level spacing. Per the Phase 4
 * plan, swap incrementally — start with the home page, then PDP, then loja,
 * then cart. Mixing this with the existing ad-hoc `py-16 lg:py-24` patterns
 * is fine during the migration.
 *
 * Spacing scale (mobile → desktop):
 *   tight   → py-12 lg:py-16   — sub-sections, dense content
 *   default → py-16 lg:py-24   — most sections
 *   loose   → py-24 lg:py-32   — emphasized story moments
 *   hero    → py-32 lg:py-40   — hero, closing CTA
 *   none    → no vertical padding (parent owns the rhythm)
 *
 * Backgrounds map to the warm-shifted palette already in globals.css.
 */
const SPACING_CLASSES: Record<SectionSpacing, string> = {
  tight: 'py-12 lg:py-16',
  default: 'py-16 lg:py-24',
  loose: 'py-24 lg:py-32',
  hero: 'py-32 lg:py-40',
  none: '',
}

const BACKGROUND_CLASSES: Record<SectionBackground, string> = {
  default: 'bg-smoke-50',
  muted: 'bg-smoke-100',
  accent: 'bg-brand-500 text-white',
  dark: 'bg-charcoal-900 text-smoke-50',
  inverted: 'bg-charcoal-900 text-smoke-50 grain-overlay',
}

export function Section({
  spacing = 'default',
  background = 'default',
  id,
  className,
  children,
}: SectionProps) {
  return (
    <section
      id={id}
      className={clsx(SPACING_CLASSES[spacing], BACKGROUND_CLASSES[background], className)}
    >
      {children}
    </section>
  )
}
