'use client'

import NextImage, { ImageProps as NextImageProps } from 'next/image'
import { forwardRef } from 'react'
import clsx from 'clsx'

interface ImageProps extends Omit<NextImageProps, 'alt'> {
  alt: string
  variant?: 'thumbnail' | 'card' | 'detail'
}

const sizeMap = {
  thumbnail: { width: 50, height: 50 },
  card: { width: 250, height: 250 },
  detail: { width: 500, height: 500 },
}

const Image = forwardRef<HTMLImageElement, ImageProps>(
  ({ alt, variant = 'card', className, ...props }, ref) => {
    const sizes = sizeMap[variant]
    return (
      <div className={clsx('relative overflow-hidden rounded-lg', className)}>
        <NextImage
          ref={ref}
          alt={alt}
          width={sizes.width}
          height={sizes.height}
          className="h-full w-full object-cover"
          {...props}
        />
      </div>
    )
  }
)
Image.displayName = 'Image'

export { Image }
