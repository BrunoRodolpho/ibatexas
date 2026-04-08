'use client'

import { Heart } from 'lucide-react'
import { useWishlistStore } from '@/domains/wishlist'
import { useTranslations } from 'next-intl'
import { useUIStore } from '@/domains/ui'
import { track } from '@/domains/analytics'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'

interface WishlistButtonProps {
  readonly productId: string
  readonly className?: string
  readonly size?: 'sm' | 'md'
}

/**
 * Heart toggle button for wishlist/favorites. Used on product cards and PDP.
 *
 * IMPORTANT — selector subscription:
 *   The previous version did `useWishlistStore((s) => s.isFavorite(productId))`.
 *   That selector only reads `s.isFavorite` (a stable function reference) — it
 *   never touches `s.items`, so Zustand never re-runs it when items mutate, and
 *   the heart visually never flipped state. We now subscribe directly to
 *   `s.items.includes(productId)` so the component re-renders on every toggle.
 */
export function WishlistButton({ productId, className, size = 'md' }: WishlistButtonProps) {
  const t = useTranslations()
  const { addToast } = useUIStore()
  const isFavorite = useWishlistStore((s) => s.items.includes(productId))
  const toggle = useWishlistStore((s) => s.toggle)

  // Drive a one-shot pop animation on toggle. Triggered manually rather than
  // bound to `isFavorite` so it fires for both add and remove.
  const [isPopping, setIsPopping] = useState(false)
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (popTimerRef.current) clearTimeout(popTimerRef.current)
  }, [])

  const iconSize = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'
  const btnSize = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10'

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const wasFavorite = isFavorite
    toggle(productId)
    setIsPopping(true)
    if (popTimerRef.current) clearTimeout(popTimerRef.current)
    popTimerRef.current = setTimeout(() => setIsPopping(false), 320)
    track('wishlist_toggled', { productId, action: wasFavorite ? 'removed' : 'added' })
    addToast(
      wasFavorite ? t('wishlist.removed') : t('wishlist.added'),
      'success',
    )
  }

  return (
    <button
      onClick={handleClick}
      className={clsx(
        btnSize,
        'flex items-center justify-center rounded-full backdrop-blur-sm transition-all duration-300 focus-brand',
        // Active = filled red bubble (clearly readable over any product image).
        // Inactive = translucent white bubble with a hairline outline icon.
        isFavorite
          ? 'bg-accent-red shadow-md hover:bg-accent-red/90'
          : 'bg-smoke-50/80 hover:bg-smoke-50 hover:scale-110 active:scale-95',
        isPopping && 'animate-heart-pop',
        className,
      )}
      aria-label={isFavorite ? t('wishlist.removed') : t('wishlist.added')}
      aria-pressed={isFavorite}
    >
      <Heart
        className={clsx(
          iconSize,
          'transition-colors duration-300',
          isFavorite
            ? 'fill-white text-white'
            : 'fill-none text-[var(--color-text-secondary)]',
        )}
      />
    </button>
  )
}
