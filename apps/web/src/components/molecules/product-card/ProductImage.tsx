'use client'

import NextImage from 'next/image'
import { BLUR_PLACEHOLDER } from '@/lib/constants'

interface ProductImageProps {
  readonly displayImage: string | null
  readonly title: string
  readonly priority?: boolean
  readonly sizes: string
  readonly hoverImage?: string | null
  readonly scaleOnHover?: boolean
}

export function ProductImage({
  displayImage,
  title,
  priority,
  sizes,
  hoverImage,
  scaleOnHover,
}: ProductImageProps) {
  if (!displayImage) {
    return (
      <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 grain-overlay flex items-center justify-center">
        <span className="font-display text-xs tracking-[0.2em] text-smoke-300/30 uppercase">IbateXas</span>
      </div>
    )
  }

  return (
    <>
      <NextImage
        src={displayImage}
        alt={title}
        fill
        priority={priority}
        placeholder={priority ? undefined : 'blur'}
        blurDataURL={BLUR_PLACEHOLDER}
        sizes={sizes}
        className={`object-cover contrast-[1.08]${scaleOnHover ? ' group-hover:scale-[1.04] transition-transform duration-800 ease-luxury' : ''}`}
      />
      {hoverImage && (
        <NextImage
          src={hoverImage}
          alt={`${title} — alternativa`}
          fill
          sizes={sizes}
          className="object-cover contrast-[1.08] absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-luxury"
        />
      )}
      <div className="absolute inset-0 bg-brand-50/5 mix-blend-multiply pointer-events-none" />
    </>
  )
}
