'use client'

export interface PageShellProps {
  readonly children: React.ReactNode
  readonly className?: string
}

export function PageShell({ children, className }: PageShellProps) {
  return <div className={`space-y-6 ${className ?? ''}`}>{children}</div>
}
