import React from 'react'
import { Button } from '../atoms'
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

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10)
    if (!isNaN(value) && value >= min && value <= max) {
      onQuantityChange(value)
    }
  }

  const btnSize = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-10 w-10' : 'h-9 w-9'
  const inputSize = size === 'sm' ? 'w-8 text-sm' : size === 'lg' ? 'w-12 text-lg' : 'w-10 text-base'

  return (
    <div className={clsx('flex items-center gap-2 rounded-lg border border-slate-300 bg-white w-fit')}>
      <button
        onClick={handleDecrease}
        disabled={quantity <= min}
        className={clsx(
          btnSize,
          'flex items-center justify-center font-bold text-slate-700',
          'hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed'
        )}
        aria-label="Diminuir quantidade"
      >
        −
      </button>

      <input
        type="number"
        value={quantity}
        onChange={handleInputChange}
        min={min}
        max={max}
        className={clsx(
          inputSize,
          'text-center border-0 outline-none bg-transparent font-semibold'
        )}
        aria-label="Quantidade"
      />

      <button
        onClick={handleIncrease}
        disabled={quantity >= max}
        className={clsx(
          btnSize,
          'flex items-center justify-center font-bold text-slate-700',
          'hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed'
        )}
        aria-label="Aumentar quantidade"
      >
        +
      </button>
    </div>
  )
}
