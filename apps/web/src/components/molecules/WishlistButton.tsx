'use client'

import { Heart } from 'lucide-react'
import { useWishlistStore } from '@/domains/wishlist'
import { useTranslations } from 'next-intl'
import { useUIStore } from '@/domains/ui'
import { track } from '@/domains/analytics'
import clsx from 'clsx'

interface WishlistButtonProps {
  readonly productId: string
  readonly className?: string
  readonly size?: 'sm' | 'md'
}

/**
 * Heart toggle button for wishlist/favorites.
 * Placed on ProductCard and PDP.
 */
export function WishlistButton({ productId, className, size = 'md' }: WishlistButtonProps) {
  const t = useTranslations()
  const { addToast } = useUIStore()
  const isFavorite = useWishlistStore((s) => s.isFavorite(productId))
  const toggle = useWishlistStore((s) => s.toggle)

  const iconSize = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'
  const btnSize = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10'

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    toggle(productId)
    track('wishlist_toggled', { productId, action: isFavorite ? 'removed' : 'added' })
    addToast(
      isFavorite ? t('wishlist.removed') : t('wishlist.added'),
      'success',
    )
  }

  return (
    <button
      onClick={handleClick}
      className={clsx(
        btnSize,
        'flex items-center justify-center rounded-full bg-smoke-50/80 backdrop-blur-sm transition-all duration-300',
        'hover:bg-smoke-50 hover:scale-110 active:scale-95',
        className,
      )}
      aria-label={isFavorite ? t('wishlist.removed') : t('wishlist.added')}
    >
      <Heart
        className={clsx(
          iconSize,
          'transition-colors duration-300',
          isFavorite
            ? 'fill-accent-red text-accent-red'
            : 'fill-none text-smoke-400',
        )}
      />
    </button>
  )
}
