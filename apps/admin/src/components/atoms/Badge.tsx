'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'

const badgeVariants = cva(
  'inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-medium uppercase tracking-editorial',
  {
    variants: {
      variant: {
        default: 'bg-smoke-100 text-smoke-600',
        success: 'bg-smoke-100 text-accent-green',
        warning: 'bg-brand-50 text-brand-800',
        danger: 'bg-brand-50 text-accent-red',
        info: 'bg-smoke-100 text-smoke-600',
        hero: 'bg-charcoal-900 text-smoke-50',
        feature: 'bg-brand-100 text-brand-700',
        primary: 'bg-brand-100 text-brand-700',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={badgeVariants({ variant, className })} {...props} />
  )
)
Badge.displayName = 'Badge'

export { Badge, badgeVariants }
