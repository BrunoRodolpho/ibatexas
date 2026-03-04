'use client'

import clsx from 'clsx'

interface SkeletonProps {
  variant?: 'text' | 'square' | 'circle' | 'rect'
  width?: string
  height?: string
  className?: string
}

/**
 * Generic loading skeleton atom.
 * Uses the existing `.skeleton` shimmer class from globals.css.
 *
 * @example
 *   <Skeleton variant="text" width="w-3/4" />
 *   <Skeleton variant="square" className="aspect-square" />
 *   <Skeleton variant="circle" className="w-12 h-12" />
 */
export function Skeleton({ variant = 'rect', width, height, className }: SkeletonProps) {
  const base = 'skeleton'

  const variantClass = {
    text: 'h-4 rounded-sm',
    square: 'rounded-card',
    circle: 'rounded-full',
    rect: 'rounded-sm',
  }[variant]

  return (
    <div
      className={clsx(base, variantClass, width, height, className)}
      aria-hidden="true"
    />
  )
}
