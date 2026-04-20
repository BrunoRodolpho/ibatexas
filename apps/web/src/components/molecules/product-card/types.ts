'use client'

import type { useTranslations } from 'next-intl'

export type {
  ProductCardData,
  CartState,
  CardCallbacks,
} from '@ibatexas/ui'

/** Badge priority order -- first match wins (only 1 badge shown) */
export const BADGE_PRIORITY = ['edicao_limitada', 'chef_choice', 'popular', 'novo'] as const

/** Resolve which badge to show based on tag priority */
export function resolvePriorityTag(tags?: string[]): string | undefined {
  return tags?.find((tag) =>
    BADGE_PRIORITY.includes(tag as (typeof BADGE_PRIORITY)[number])
  )
}

/** Compute discount percentage from price vs compare-at */
export function computeDiscount(price: number, compareAtPrice?: number): { hasDiscount: boolean; discountPercent: number } {
  const hasDiscount = Boolean(compareAtPrice && compareAtPrice > price)
  const discountPercent = hasDiscount && compareAtPrice
    ? Math.round(((compareAtPrice - price) / compareAtPrice) * 100)
    : 0
  return { hasDiscount, discountPercent }
}

/** Shorthand for the translations hook return type */
export type T = ReturnType<typeof useTranslations>

/** Full props accepted by the ProductCard facade (backward-compatible) */
export interface ProductCardProps {
  readonly id: string
  readonly title: string
  readonly subtitle?: string
  readonly imageUrl?: string | null
  readonly images?: string[]
  readonly price: number
  readonly compareAtPrice?: number
  readonly variantCount?: number
  readonly rating?: number
  readonly reviewCount?: number
  readonly tags?: string[]
  readonly weight?: string
  readonly servings?: number
  readonly stockCount?: number
  readonly availabilityWindow?: string
  readonly description?: string | null
  readonly isBundle?: boolean
  readonly bundleServings?: number
  readonly href?: string
  readonly onAddToCart?: () => void | Promise<void>
  readonly priority?: boolean
  /** Current quantity in cart (0 or undefined = not in cart) */
  readonly cartQuantity?: number
  /** Callback to update quantity in cart */
  readonly onUpdateQuantity?: (qty: number) => void
  /** Callback to remove item from cart */
  readonly onRemoveFromCart?: () => void
  /** Number of orders today -- shown as scarcity signal when >= 5 */
  readonly ordersToday?: number
  /** Card layout variant */
  readonly variant?: 'vertical' | 'horizontal'
}
