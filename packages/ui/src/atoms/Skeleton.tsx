'use client'

import clsx from 'clsx'

export interface SkeletonProps {
  readonly variant?: 'text' | 'square' | 'circle' | 'rect'
  readonly width?: string
  readonly height?: string
  readonly className?: string
}

const variantClasses: Record<NonNullable<SkeletonProps['variant']>, string> = {
  text: 'h-4 rounded-sm',
  square: 'rounded-card',
  circle: 'rounded-full',
  rect: 'rounded-sm',
}

export function Skeleton({ variant = 'rect', width, height, className }: SkeletonProps) {
  return (
    <div
      className={clsx('skeleton', variantClasses[variant], width, height, className)}
      aria-hidden="true"
    />
  )
}
