'use client'

import clsx from 'clsx'

export interface TabItem {
  key: string
  label: string
  count?: number
}

export interface TabsProps {
  readonly items: TabItem[]
  readonly activeKey: string
  readonly onChange: (key: string) => void
  readonly className?: string
}

export function Tabs({ items, activeKey, onChange, className }: TabsProps) {
  return (
    <div className={clsx('flex border-b border-smoke-200', className)}>
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => onChange(item.key)}
          className={clsx(
            'flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-all duration-500',
            activeKey === item.key
              ? 'border-charcoal-900 text-charcoal-900'
              : 'border-transparent text-smoke-400 hover:border-smoke-300 hover:text-charcoal-700'
          )}
          style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
        >
          {item.label}
          {item.count !== undefined && (
            <span
              className={clsx(
                'rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-wider',
                activeKey === item.key
                  ? 'bg-charcoal-900 text-smoke-50'
                  : 'bg-smoke-100 text-smoke-400'
              )}
            >
              {item.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
