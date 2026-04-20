import clsx from 'clsx'

type ContainerSize = 'narrow' | 'default' | 'xl' | 'wide'
type ContainerPadding = 'tight' | 'default' | 'loose' | 'none'

interface ContainerProps {
  readonly size?: ContainerSize
  readonly padding?: ContainerPadding
  readonly as?: 'div' | 'section' | 'article' | 'main' | 'header' | 'footer'
  readonly className?: string
  readonly children: React.ReactNode
}

/**
 * Standardized horizontal container.
 *
 * Replaces the ad-hoc `mx-auto max-w-[1280px] px-6 lg:px-8` patterns scattered
 * across pages — every page used a different max-width (1200, 1280, 6xl, 7xl)
 * and a different padding combo. Adopt this incrementally per Phase 5.
 *
 *   narrow  → 720px  — long-form text, checkout
 *   default → 1200px — PDP, loja, most content pages
 *   xl      → 1280px — home, lista-desejos (preserves existing layouts)
 *   wide    → 1440px — full-bleed sections that still want a max
 *
 * Padding scale:
 *   tight   → px-4 sm:px-5
 *   default → px-5 sm:px-6 lg:px-8       (matches the existing home page)
 *   loose   → px-6 sm:px-8 lg:px-12
 *   none    → no horizontal padding (image-first sections)
 */
const SIZE_CLASSES: Record<ContainerSize, string> = {
  narrow: 'max-w-[720px]',
  default: 'max-w-[1200px]',
  xl: 'max-w-[1280px]',
  wide: 'max-w-[1440px]',
}

const PADDING_CLASSES: Record<ContainerPadding, string> = {
  tight: 'px-4 sm:px-5',
  default: 'px-5 sm:px-6 lg:px-8',
  loose: 'px-6 sm:px-8 lg:px-12',
  none: '',
}

export function Container({
  size = 'default',
  padding = 'default',
  as: Component = 'div',
  className,
  children,
}: ContainerProps) {
  return (
    <Component
      className={clsx('mx-auto w-full', SIZE_CLASSES[size], PADDING_CLASSES[padding], className)}
    >
      {children}
    </Component>
  )
}
