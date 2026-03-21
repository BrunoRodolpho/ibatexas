'use client'

import NextImage, { ImageProps as NextImageProps } from 'next/image'
import type { Ref } from 'react'
import clsx from 'clsx'
import { BLUR_PLACEHOLDER } from '@/lib/constants'

interface ImageProps extends Omit<NextImageProps, 'alt' | 'fill'> {
  readonly alt: string
  readonly variant?: 'thumbnail' | 'card' | 'detail'
}

/**
 * Responsive image wrapper.
 * - `thumbnail`: fixed 50x50
 * - `card` / `detail`: uses `fill` + container aspect-ratio so the
 *   image always respects the parent's dimensions.
 */
const containerClass: Record<string, string> = {
  thumbnail: 'relative h-[50px] w-[50px] flex-shrink-0 overflow-hidden rounded-sm',
  card:      'relative w-full overflow-hidden rounded-card',
  detail:    'relative w-full overflow-hidden rounded-card',
}

function Image({ ref, alt, variant = 'card', className, width, height, sizes, ...props }: ImageProps & { ref?: Ref<HTMLImageElement> }) {
  const isFill = variant !== 'thumbnail'

  return (
    <div className={clsx(containerClass[variant], className)}>
      <NextImage
        ref={ref}
        alt={alt}
        className="h-full w-full object-cover"
        placeholder="blur"
        blurDataURL={BLUR_PLACEHOLDER}
        sizes={sizes ?? (variant === 'detail' ? '(max-width: 768px) 100vw, 50vw' : '(max-width: 768px) 100vw, 33vw')}
        {...(isFill
          ? { fill: true }
          : { width: Number(width) || 50, height: Number(height) || 50 }
        )}
        {...props}
      />
    </div>
  )
}

export { Image }
