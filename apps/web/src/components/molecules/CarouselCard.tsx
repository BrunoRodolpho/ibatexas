'use client'

import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { formatBRL, formatRating } from '@/lib/format'

interface CarouselCardProps {
  readonly id: string
  readonly title: string
  readonly description?: string | null
  readonly imageUrl?: string | null
  readonly images?: string[]
  readonly price: number
  readonly variantCount?: number
  readonly rating?: number
  readonly tags?: string[]
}

export const CarouselCard = ({
  id,
  title,
  description,
  imageUrl,
  images,
  price,
  variantCount,
  rating,
  tags,
}: CarouselCardProps) => {
  const priceFormatted = formatBRL(price)
  const hasMultipleVariants = (variantCount ?? 0) > 1

  const displayImage = imageUrl || images?.[0] || null
  const linkHref = `/loja/produto/${id}`

  return (
    <Link
      href={linkHref}
      className="group block flex-shrink-0 w-[min(630px,92vw)] rounded-sm overflow-hidden shadow-card hover:shadow-xl hover:-translate-y-1 transition-all duration-500 ease-luxury"
    >
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

        {/* Tag pill */}
        {tags?.includes('popular') && (
          <div className="absolute top-[5%] right-[4%] z-10 bg-brand-500/90 backdrop-blur-sm text-white px-[5%] py-[2%] text-[clamp(7px,2vw,9px)] font-semibold uppercase tracking-editorial rounded-sm">
            Popular
          </div>
        )}

        {/* Frosted bottom overlay */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-charcoal-900/80 via-charcoal-900/40 to-transparent pt-[18%] pb-[6%] px-[5%]">
          <h3 className="text-[clamp(11px,3.5vw,14px)] font-medium text-white leading-snug line-clamp-1">
            {title}
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
      </div>
    </Link>
  )
}
