'use client'

export interface FilterBarProps {
  readonly children: React.ReactNode
  readonly className?: string
}

export function FilterBar({ children, className }: FilterBarProps) {
  return <div className={`flex flex-wrap items-center gap-3 ${className ?? ''}`}>{children}</div>
}
