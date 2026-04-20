'use client'

import { ChevronRight } from 'lucide-react'

export interface SectionHeaderProps {
  readonly title: string
  readonly action?: React.ReactNode
  readonly collapsible?: boolean
  readonly expanded?: boolean
  readonly onToggle?: () => void
}

export function SectionHeader({ title, action, collapsible, expanded, onToggle }: SectionHeaderProps) {
  const labelClass = 'text-sm font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)]'

  if (collapsible) {
    return (
      <div className="flex items-center justify-between">
        <button
          onClick={onToggle}
          className={`flex items-center gap-2 ${labelClass} hover:text-charcoal-700`}
        >
          <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          {title}
        </button>
        {action && <div>{action}</div>}
      </div>
    )
  }

  if (action) {
    return (
      <div className="flex items-center justify-between">
        <h2 className={labelClass}>{title}</h2>
        <div>{action}</div>
      </div>
    )
  }

  return <h2 className={labelClass}>{title}</h2>
}
