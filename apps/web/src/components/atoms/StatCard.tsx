'use client'

import type { LucideIcon } from 'lucide-react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

const accentColors: Record<string, string> = {
  default: 'border-l-slate-300',
  success: 'border-l-emerald-500',
  warning: 'border-l-amber-500',
  danger: 'border-l-red-500',
  info: 'border-l-blue-500',
}

const iconColors: Record<string, string> = {
  default: 'text-slate-500',
  success: 'text-emerald-600',
  warning: 'text-amber-600',
  danger: 'text-red-600',
  info: 'text-blue-600',
}

interface StatCardProps {
  label: string
  value: string | number
  icon?: LucideIcon
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info'
  trend?: number
  subLabel?: string
  isLoading?: boolean
}

export function StatCard({ label, value, icon: Icon, trend, subLabel, variant = 'default', isLoading }: StatCardProps) {
  if (isLoading) {
    return (
      <div className={`rounded-lg border border-slate-200 border-l-2 ${accentColors[variant]} bg-white p-5`}>
        <div className="h-4 w-16 animate-pulse rounded bg-slate-100" />
        <div className="mt-3 h-7 w-24 animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-3 w-20 animate-pulse rounded bg-slate-100" />
      </div>
    )
  }

  const TrendIcon = trend === undefined ? null : trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus
  const trendColor = trend === undefined ? '' : trend > 0 ? 'text-emerald-600' : trend < 0 ? 'text-red-600' : 'text-slate-400'

  return (
    <div className={`rounded-lg border border-slate-200 border-l-2 ${accentColors[variant]} bg-white p-5`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {Icon && <Icon className={`h-4 w-4 ${iconColors[variant]}`} />}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <p className="text-xl font-semibold text-slate-900">{value}</p>
        {TrendIcon && (
          <span className={`flex items-center gap-0.5 text-xs font-medium ${trendColor}`}>
            <TrendIcon className="h-3 w-3" />
            {Math.abs(trend!)}%
          </span>
        )}
      </div>
      {subLabel && <p className="mt-1 text-xs text-slate-400">{subLabel}</p>}
    </div>
  )
}
