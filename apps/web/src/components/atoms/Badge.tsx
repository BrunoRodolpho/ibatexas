'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'

const badgeVariants = cva('inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-medium uppercase tracking-editorial', {
  variants: {
    variant: {
      default: 'bg-smoke-100 text-charcoal-900',
      primary: 'bg-brand-100 text-brand-700',
      success: 'bg-green-100 text-green-800',
      warning: 'bg-yellow-100 text-yellow-800',
      danger: 'bg-red-100 text-red-800',
      info: 'bg-blue-100 text-blue-800',
      vegetariano: 'bg-green-100 text-green-800',
      vegan: 'bg-emerald-100 text-emerald-800',
      sem_gluten: 'bg-yellow-100 text-yellow-800',
      sem_lactose: 'bg-blue-100 text-blue-800',
      novo: 'bg-purple-100 text-purple-800',
      popular: 'bg-pink-100 text-pink-800',
      chef_choice: 'bg-brand-100 text-brand-700',
      // Merchandise tag variants
      exclusivo: 'bg-purple-100 text-purple-800',
      edicao_limitada: 'bg-pink-100 text-pink-800',
      kit: 'bg-blue-100 text-blue-800',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

const Badge = forwardRef<HTMLDivElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} className={badgeVariants({ variant, className })} {...props} />
))
Badge.displayName = 'Badge'

export { Badge, badgeVariants }
