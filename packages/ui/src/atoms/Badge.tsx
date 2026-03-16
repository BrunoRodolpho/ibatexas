'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'

const badgeVariants = cva('inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-medium uppercase tracking-editorial', {
  variants: {
    variant: {
      // ── 3-tier badge hierarchy ────────────────────────────
      // Tier 1: Hero (dark inverted — highest status)
      default: 'bg-smoke-100 text-smoke-600',
      hero: 'bg-charcoal-900 text-smoke-50',
      // Tier 2: Feature (brand-tinted — promotional)
      feature: 'bg-brand-100 text-brand-700',
      // Tier 3: Informational (neutral — dietary, metadata)
      info: 'bg-smoke-100 text-smoke-600',

      // ── Semantic mappings (map to tiers) ──────────────────
      // Hero tier
      popular: 'bg-charcoal-900 text-smoke-50',
      chef_choice: 'bg-charcoal-900 text-smoke-50',
      edicao_limitada: 'bg-charcoal-900 text-smoke-50',
      // Feature tier
      novo: 'bg-brand-100 text-brand-700',
      exclusivo: 'bg-brand-100 text-brand-700',
      kit: 'bg-brand-100 text-brand-700',
      primary: 'bg-brand-100 text-brand-700',
      // Informational tier
      vegetariano: 'bg-smoke-100 text-smoke-600',
      vegan: 'bg-smoke-100 text-smoke-600',
      sem_gluten: 'bg-smoke-100 text-smoke-600',
      sem_lactose: 'bg-smoke-100 text-smoke-600',
      // System
      success: 'bg-smoke-100 text-accent-green',
      warning: 'bg-brand-50 text-brand-800',
      danger: 'bg-brand-50 text-accent-red',
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
