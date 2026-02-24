'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'

const badgeVariants = cva('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium', {
  variants: {
    variant: {
      default: 'bg-slate-100 text-slate-800',
      primary: 'bg-amber-100 text-amber-800',
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
      chef_choice: 'bg-amber-100 text-amber-800',
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
