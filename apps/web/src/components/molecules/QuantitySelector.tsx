import React from 'react'
import clsx from 'clsx'
import { useTranslations } from 'next-intl'

interface QuantitySelectorProps {
  quantity: number
  max?: number
  min?: number
  onQuantityChange: (quantity: number) => void
  size?: 'sm' | 'md' | 'lg'
}

export const QuantitySelector: React.FC<QuantitySelectorProps> = ({
  quantity,
  max = 99,
  min = 1,
  onQuantityChange,
  size = 'md',
}) => {
  const t = useTranslations()

  const handleDecrease = () => {
    if (quantity > min) {
      onQuantityChange(quantity - 1)
    }
  }

  const handleIncrease = () => {
    if (quantity < max) {
      onQuantityChange(quantity + 1)
    }
  }

  const sizeMap = {
    sm: { container: 'h-11', btn: 'w-11 h-11', count: 'w-10 text-xs' },
    md: { container: 'h-11', btn: 'w-11 h-11', count: 'w-12 text-sm' },
    lg: { container: 'h-12', btn: 'w-12 h-12', count: 'w-14 text-base' },
  } as const
  const { container: containerSize, btn: btnSize, count: countSize } = sizeMap[size]

  return (
    <div className={clsx('inline-flex items-center border border-smoke-200 rounded-sm w-fit', containerSize)}>
      <button
        onClick={handleDecrease}
        disabled={quantity <= min}
        className={clsx(
          btnSize,
          'flex items-center justify-center text-charcoal-900 transition-colors duration-300',
          'hover:bg-smoke-100 disabled:opacity-50 disabled:cursor-not-allowed',
        )}
        aria-label={t('common.decrease_quantity')}
      >
        −
      </button>

      <span
        className={clsx(
          countSize,
          'text-center tabular-nums font-medium text-charcoal-900 select-none',
        )}
        aria-label={t('common.quantity_label')}
      >
        {quantity}
      </span>

      <button
        onClick={handleIncrease}
        disabled={quantity >= max}
        className={clsx(
          btnSize,
          'flex items-center justify-center text-charcoal-900 transition-colors duration-300',
          'hover:bg-smoke-100 disabled:opacity-50 disabled:cursor-not-allowed',
        )}
        aria-label={t('common.increase_quantity')}
      >
        +
      </button>
    </div>
  )
}
