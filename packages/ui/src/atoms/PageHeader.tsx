'use client'

import type { LucideIcon } from 'lucide-react'

export interface PageHeaderProps {
  readonly title: string
  readonly subtitle?: string
  readonly icon?: LucideIcon
  /** Trailing slot for action buttons or links */
  readonly action?: React.ReactNode
}

export function PageHeader({ title, subtitle, icon: Icon, action }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-3">
          {Icon && <Icon className="h-5 w-5 text-brand-600" />}
          <h1 className="text-2xl font-display text-charcoal-900">{title}</h1>
        </div>
        {subtitle && (
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  )
}
