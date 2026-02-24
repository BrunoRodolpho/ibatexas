'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import type { LucideIcon } from 'lucide-react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

const statCardVariants = cva(
  'rounded-xl border p-6 bg-white',
  {
    variants: {
      variant: {
        default: 'border-slate-200',
        success: 'border-emerald-200 bg-emerald-50',
        warning: 'border-amber-200 bg-amber-50',
        danger: 'border-red-200 bg-red-50',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

const iconWrapperVariants = cva('flex h-10 w-10 items-center justify-center rounded-lg', {
  variants: {
    variant: {
      default: 'bg-slate-100 text-slate-600',
      success: 'bg-emerald-100 text-emerald-600',
      warning: 'bg-amber-100 text-amber-700',
      danger: 'bg-red-100 text-red-600',
    },
  },
  defaultVariants: { variant: 'default' },
})

interface StatCardProps extends VariantProps<typeof statCardVariants> {
  label: string
  value: string | number
  icon?: LucideIcon
  trend?: number // percentage, positive = up, negative = down
  subLabel?: string
  isLoading?: boolean
}

export function StatCard({ label, value, icon: Icon, trend, subLabel, variant, isLoading }: StatCardProps) {
  if (isLoading) {
    return (
      <div className={statCardVariants({ variant })}>
        <div className="flex items-start justify-between">
          <div className="h-10 w-10 animate-pulse rounded-lg bg-slate-200" />
        </div>
        <div className="mt-4 h-8 w-24 animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-4 w-16 animate-pulse rounded bg-slate-100" />
      </div>
    )
  }

  const TrendIcon = trend === undefined ? null : trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus
  const trendColor = trend === undefined ? '' : trend > 0 ? 'text-emerald-600' : trend < 0 ? 'text-red-600' : 'text-slate-500'

  return (
    <div className={statCardVariants({ variant })}>
      <div className="flex items-start justify-between">
        {Icon && (
          <div className={iconWrapperVariants({ variant })}>
            <Icon className="h-5 w-5" />
          </div>
        )}
        {TrendIcon && (
          <span className={`flex items-center gap-1 text-sm font-medium ${trendColor}`}>
            <TrendIcon className="h-4 w-4" />
            {Math.abs(trend!)}%
          </span>
        )}
      </div>
      <div className="mt-4">
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="mt-1 text-sm font-medium text-slate-600">{label}</p>
        {subLabel && <p className="mt-0.5 text-xs text-slate-500">{subLabel}</p>}
      </div>
    </div>
  )
}
