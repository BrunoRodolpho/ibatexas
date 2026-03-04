import React from 'react'
import clsx from 'clsx'

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

  const containerSize = size === 'sm' ? 'h-8' : size === 'lg' ? 'h-12' : 'h-10'
  const btnSize = size === 'sm' ? 'w-8 h-8' : size === 'lg' ? 'w-12 h-12' : 'w-10 h-10'
  const countSize = size === 'sm' ? 'w-8 text-xs' : size === 'lg' ? 'w-14 text-base' : 'w-12 text-sm'

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
        aria-label="Diminuir quantidade"
      >
        −
      </button>

      <span
        className={clsx(
          countSize,
          'text-center tabular-nums font-medium text-charcoal-900 select-none',
        )}
        aria-label="Quantidade"
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
        aria-label="Aumentar quantidade"
      >
        +
      </button>
    </div>
  )
}
