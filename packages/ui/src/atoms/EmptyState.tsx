'use client'

import type { LucideIcon } from 'lucide-react'

export interface EmptyStateProps {
  readonly icon?: LucideIcon
  readonly title: string
  readonly subtitle?: string
  readonly action?: React.ReactNode
}

export function EmptyState({ icon: Icon, title, subtitle, action }: EmptyStateProps) {
  return (
    <div className="rounded-sm border border-dashed border-smoke-300 bg-smoke-50/50 p-8 text-center">
      {Icon && <Icon className="mx-auto h-8 w-8 text-smoke-300 mb-2" />}
      <p className="text-sm text-[var(--color-text-secondary)]">{title}</p>
      {subtitle && <p className="text-xs text-smoke-400 mt-1">{subtitle}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
