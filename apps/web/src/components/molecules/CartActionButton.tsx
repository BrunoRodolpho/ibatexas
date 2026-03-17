'use client'

import React from 'react'
import { Plus, Minus, Check, Trash2 } from 'lucide-react'

interface CartActionButtonProps {
  readonly productId: string
  readonly productTitle: string
  readonly cartQty: number
  readonly isAdded: boolean
  readonly onAdd: (productId: string, e: React.MouseEvent) => void
  readonly onIncrement: (productId: string, e: React.MouseEvent) => void
  readonly onDecrement: (productId: string, e: React.MouseEvent) => void
  readonly t: (key: string) => string
}

export function CartActionButton({
  productId, productTitle, cartQty, isAdded, onAdd, onIncrement, onDecrement, t,
}: CartActionButtonProps) {
  if (cartQty > 0) {
    return (
      <div className="flex items-center bg-charcoal-900 rounded-sm h-9 overflow-hidden">
        <button
          onClick={(e) => onDecrement(productId, e)}
          className={`w-10 h-9 flex items-center justify-center hover:bg-charcoal-700 active:scale-90 transition-all ${cartQty === 1 ? 'text-accent-red' : 'text-smoke-50'}`}
          aria-label={cartQty === 1 ? t('common.remove') : t('common.decrease_quantity')}
        >
          {cartQty === 1 ? <Trash2 className="w-3.5 h-3.5" strokeWidth={2.5} /> : <Minus className="w-3.5 h-3.5" strokeWidth={2.5} />}
        </button>
        <span className="text-xs font-bold text-smoke-50 tabular-nums min-w-[1.25rem] text-center">{cartQty}</span>
        <button
          onClick={(e) => onIncrement(productId, e)}
          className="w-10 h-9 flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all"
          aria-label={t('common.increase_quantity')}
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={(e) => onAdd(productId, e)}
      className={`inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-sm transition-all duration-300 ease-luxury active:scale-95 ${
        isAdded
          ? 'bg-accent-green text-white'
          : 'bg-brand-500 text-white hover:bg-brand-600'
      }`}
      aria-label={`${t('product.add_to_cart')} - ${productTitle}`}
    >
      {isAdded ? (
        <>
          <Check className="w-4 h-4" strokeWidth={2.5} />
          {t('product.added_short')}
        </>
      ) : (
        <>
          <Plus className="w-4 h-4" strokeWidth={2} />
          {t('common.add')}
        </>
      )}
    </button>
  )
}
