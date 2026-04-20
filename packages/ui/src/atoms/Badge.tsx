'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import type { Ref } from 'react'

const badgeVariants = cva('inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-medium uppercase tracking-editorial', {
  variants: {
    variant: {
      // ── 3-tier badge hierarchy ────────────────────────────
      // Tier 1: Hero (frosted glass — subtle, premium feel)
      default: 'bg-smoke-100 text-smoke-600',
      hero: 'bg-white/70 backdrop-blur-sm text-charcoal-900 ring-1 ring-smoke-200/50',
      // Tier 2: Feature (brand-tinted — promotional)
      feature: 'bg-brand-50/80 backdrop-blur-sm text-brand-700 ring-1 ring-brand-200/40',
      // Tier 3: Informational (neutral — dietary, metadata)
      info: 'bg-smoke-100 text-smoke-600',

      // ── Semantic mappings (map to tiers) ──────────────────
      // Hero tier
      popular: 'bg-white/70 backdrop-blur-sm text-charcoal-900 ring-1 ring-smoke-200/50',
      chef_choice: 'bg-white/70 backdrop-blur-sm text-charcoal-900 ring-1 ring-smoke-200/50',
      edicao_limitada: 'bg-white/70 backdrop-blur-sm text-charcoal-900 ring-1 ring-smoke-200/50',
      // Feature tier
      novo: 'bg-brand-50/80 backdrop-blur-sm text-brand-700 ring-1 ring-brand-200/40',
      exclusivo: 'bg-brand-50/80 backdrop-blur-sm text-brand-700 ring-1 ring-brand-200/40',
      kit: 'bg-brand-50/80 backdrop-blur-sm text-brand-700 ring-1 ring-brand-200/40',
      primary: 'bg-brand-50/80 backdrop-blur-sm text-brand-700 ring-1 ring-brand-200/40',
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

function Badge({ ref, className, variant, ...props }: BadgeProps & { ref?: Ref<HTMLDivElement> }) {
  return <div ref={ref} className={badgeVariants({ variant, className })} {...props} />
}

export { Badge, badgeVariants }
