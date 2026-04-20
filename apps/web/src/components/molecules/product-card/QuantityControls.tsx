'use client'

import { Plus, Minus, Trash2 } from 'lucide-react'
import type { T } from './types'

interface QuantityControlsProps {
  readonly cartQuantity: number
  readonly onDecrement: (e: React.MouseEvent) => void
  readonly onIncrement: (e: React.MouseEvent) => void
  readonly size: 'sm' | 'md'
  readonly t: T
}

export function QuantityControls({
  cartQuantity,
  onDecrement,
  onIncrement,
  size,
  t,
}: QuantityControlsProps) {
  const isSmall = size === 'sm'
  const btnClass = isSmall ? 'w-9 h-9' : 'w-12 h-10'
  const iconClass = isSmall ? 'w-3.5 h-3.5' : 'w-4 h-4'
  const containerClass = isSmall
    ? 'flex items-center gap-0 bg-charcoal-900 rounded-full h-9 overflow-hidden'
    : 'flex items-center justify-between bg-charcoal-900 rounded-sm h-10 overflow-hidden'
  const textClass = isSmall
    ? 'text-xs font-bold text-smoke-50 tabular-nums min-w-[1.25rem] text-center'
    : 'text-sm font-bold text-smoke-50 tabular-nums'
  const focusRing = isSmall ? '' : ' focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1'

  return (
    <div className={containerClass}>
      <button
        onClick={onDecrement}
        className={`${btnClass} flex items-center justify-center hover:bg-charcoal-700 active:scale-90 transition-all${focusRing} ${cartQuantity === 1 ? 'text-accent-red' : 'text-smoke-50'}`}
        aria-label={cartQuantity === 1 ? t('common.remove') : t('common.decrease_quantity')}
      >
        {cartQuantity === 1
          ? <Trash2 className={iconClass} strokeWidth={2.5} />
          : <Minus className={iconClass} strokeWidth={2.5} />}
      </button>
      <span className={textClass} aria-live={isSmall ? undefined : 'polite'}>{cartQuantity}</span>
      <button
        onClick={onIncrement}
        className={`${btnClass} flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all${focusRing}`}
        aria-label={t('common.increase_quantity')}
      >
        <Plus className={iconClass} strokeWidth={2.5} />
      </button>
    </div>
  )
}
