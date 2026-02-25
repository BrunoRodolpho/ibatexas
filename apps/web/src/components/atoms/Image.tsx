'use client'

import NextImage, { ImageProps as NextImageProps } from 'next/image'
import { forwardRef } from 'react'
import clsx from 'clsx'

interface ImageProps extends Omit<NextImageProps, 'alt' | 'fill'> {
  alt: string
  variant?: 'thumbnail' | 'card' | 'detail'
}

/**
 * Responsive image wrapper.
 * - `thumbnail`: fixed 50×50
 * - `card` / `detail`: uses `fill` + container aspect-ratio so the
 *   image always respects the parent's dimensions.
 */
const containerClass: Record<string, string> = {
  thumbnail: 'relative h-[50px] w-[50px] flex-shrink-0 overflow-hidden rounded-md',
  card:      'relative w-full overflow-hidden rounded-lg',
  detail:    'relative w-full overflow-hidden rounded-lg',
}

const Image = forwardRef<HTMLImageElement, ImageProps>(
  ({ alt, variant = 'card', className, width, height, sizes, ...props }, ref) => {
    const isFill = variant !== 'thumbnail'

    return (
      <div className={clsx(containerClass[variant], className)}>
        <NextImage
          ref={ref}
          alt={alt}
          className="h-full w-full object-cover"
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
)
Image.displayName = 'Image'

export { Image }
