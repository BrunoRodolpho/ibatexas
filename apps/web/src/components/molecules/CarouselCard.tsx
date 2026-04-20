'use client'

import NextImage from 'next/image'
import { Plus } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { track } from '@/domains/analytics'
import { formatBRL, formatRating } from '@/lib/format'
import { useTranslations } from 'next-intl'
import { WishlistButton } from './WishlistButton'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'

interface CarouselCardProps {
  readonly id: string
  readonly title: string
  readonly description?: string | null
  readonly imageUrl?: string | null
  readonly images?: string[]
  readonly price: number
  readonly variantCount?: number
  readonly variants?: ProductVariant[]
  readonly rating?: number
  readonly tags?: string[]
  readonly categoryHandle?: string
}

/**
 * Large showcase card used by the home product carousel.
 *
 * Now ships with a quick-add button overlaid on the image so the carousel is
 * actually interactive — previously the entire card was a passive Link, which
 * matched the user's "I clicked add and nothing happened" complaint.
 *
 * Layout pattern (matches ProductCardVertical):
 *   outer <div> with `group relative`
 *     ↳ <Link> uses `after:absolute after:inset-0` to act as a full-card click
 *       target without nesting interactive elements inside an anchor
 *     ↳ <button> sits above the link with `relative z-20` so it intercepts
 *       its own clicks. Nesting button-in-anchor is invalid HTML; siblings
 *       with z-stacking is the supported pattern in this codebase.
 */
export const CarouselCard = ({
  id,
  title,
  description,
  imageUrl,
  images,
  price,
  variantCount,
  variants,
  rating,
  tags,
  categoryHandle,
}: CarouselCardProps) => {
  const t = useTranslations()
  const addItem = useCartStore((s) => s.addItem)
  const triggerUpsell = useUIStore((s) => s.triggerUpsell)
  const addToast = useUIStore((s) => s.addToast)

  const priceFormatted = formatBRL(price)
  const hasMultipleVariants = (variantCount ?? 0) > 1

  const displayImage = imageUrl || images?.[0] || null
  const linkHref = `/loja/produto/${id}`

  const handleQuickAdd = () => {
    // Variant-required products: bounce to PDP so the user picks a variant.
    if (hasMultipleVariants) {
      window.location.assign(linkHref)
      return
    }
    const minimal = {
      id,
      title,
      price,
      imageUrl: displayImage,
      variants: variants ?? [],
    } as unknown as ProductDTO
    addItem(minimal, 1, undefined, variants?.[0])
    track('add_to_cart', { productId: id, source: 'home_carousel' })
    addToast(t('toast.added_to_cart'), 'cart')
    if (categoryHandle) triggerUpsell(categoryHandle)
  }

  return (
    <div className="group relative flex-shrink-0 w-[min(630px,92vw)] rounded-card overflow-hidden shadow-card hover:shadow-xl hover:-translate-y-1 transition-all duration-500 ease-luxury">
      {/* Image with frosted overlay */}
      <div className="relative w-full aspect-[16/10] overflow-hidden bg-smoke-100">
        {displayImage ? (
          <NextImage
            src={displayImage}
            alt={title}
            fill
            sizes="(max-width: 640px) 92vw, (max-width: 1024px) 60vw, 630px"
            loading="lazy"
            className="object-cover w-full h-full group-hover:scale-[1.02] transition-transform duration-800 ease-luxury"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 flex items-center justify-center">
            <span className="font-display text-[3.5%] sm:text-sm font-medium text-smoke-300/40 uppercase tracking-editorial">
              IbateXas
            </span>
          </div>
        )}

        {/* Warm brand tint */}
        <div className="absolute inset-0 bg-brand-50/5 mix-blend-multiply pointer-events-none z-[1]" />

        {/* Rating badge */}
        {rating && (
          <div className="absolute top-[5%] left-[4%] z-10 bg-smoke-50/90 backdrop-blur-sm text-charcoal-900 px-[4%] py-[2%] text-[clamp(8px,2.5vw,10px)] font-medium rounded-sm">
            {formatRating(rating)}
          </div>
        )}

        {/* Tag pill — top-left, frosted glass (matches Badge component style) */}
        {tags?.includes('popular') && (
          <div className="absolute top-[5%] left-[4%] z-10 bg-white/70 backdrop-blur-sm text-charcoal-900 ring-1 ring-smoke-200/50 px-[4%] py-[2%] text-[clamp(7px,2vw,9px)] font-medium uppercase tracking-editorial rounded-sm">
            Popular
          </div>
        )}

        {/* Wishlist heart — top right of image, sibling to the link's
            click-target pseudo-element so it can be tapped without navigating. */}
        <div className="absolute top-[4%] right-[3%] z-20">
          <WishlistButton productId={id} size="sm" />
        </div>

        {/* Frosted bottom overlay — title + price */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-charcoal-900/80 via-charcoal-900/40 to-transparent pt-[18%] pb-[6%] px-[5%] z-[2]">
          <h3 className="text-[clamp(11px,3.5vw,14px)] font-medium text-white leading-snug line-clamp-1">
            {/* Link uses an absolute pseudo-element to capture clicks across
                the whole card without nesting buttons inside an anchor. */}
            <Link href={linkHref} className="after:absolute after:inset-0 after:content-['']">
              {title}
            </Link>
          </h3>
          {description && (
            <p className="mt-[2%] text-[clamp(9px,2.8vw,11px)] text-smoke-200/80 line-clamp-1">
              {description}
            </p>
          )}
          <p className="mt-[3%] text-[clamp(10px,3vw,12px)] font-medium text-brand-200 tabular-nums">
            {hasMultipleVariants && (
              <span className="text-brand-300/70 mr-1">a partir de</span>
            )}
            {priceFormatted}
          </p>
        </div>

        {/* Quick-add — sits above the Link's pseudo-element via z-20.
            Always visible on mobile, fades in on desktop hover. */}
        <button
          type="button"
          onClick={handleQuickAdd}
          aria-label={`${t('product.add_to_cart')}: ${title}`}
          className="absolute bottom-[5%] right-[4%] z-20 inline-flex items-center gap-2 rounded-full bg-brand-500 text-white px-3 py-2 text-xs font-semibold shadow-lg hover:bg-brand-600 active:scale-95 transition-all duration-300 ease-luxury opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:translate-y-1 lg:group-hover:translate-y-0"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
          <span className="hidden sm:inline">{t('product.add_to_cart')}</span>
        </button>
      </div>
    </div>
  )
}
