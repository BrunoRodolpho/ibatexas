'use client'

import { Button } from '../atoms'
import { QuantitySelector } from './QuantitySelector'
import clsx from 'clsx'

interface StickyBottomBarProps {
  price: string
  quantity: number
  onQuantityChange: (qty: number) => void
  onAction: () => void
  actionLabel: string
  disabled?: boolean
  isLoading?: boolean
  className?: string
}

/**
 * Sticky mobile CTA bar — fixed at the bottom of the viewport.
 * Reusable for PDP, bundle pages, seasonal promotions, etc.
 */
export function StickyBottomBar({
  price,
  quantity,
  onQuantityChange,
  onAction,
  actionLabel,
  disabled = false,
  isLoading = false,
  className,
}: StickyBottomBarProps) {
  return (
    <div
      className={clsx(
        'fixed bottom-14 inset-x-0 bg-smoke-50/95 backdrop-blur-sm border-t border-smoke-200 p-4 z-20 lg:hidden pb-[calc(1rem+env(safe-area-inset-bottom))]',
        className,
      )}
    >
      <div className="flex items-center gap-3 max-w-lg mx-auto">
        <QuantitySelector
          quantity={quantity}
          onQuantityChange={onQuantityChange}
          min={1}
          max={99}
          size="sm"
        />
        <span className="text-sm font-semibold text-charcoal-900 tabular-nums whitespace-nowrap">
          {price}
        </span>
        <Button
          onClick={onAction}
          disabled={disabled}
          isLoading={isLoading}
          className="flex-1"
          size="md"
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}
