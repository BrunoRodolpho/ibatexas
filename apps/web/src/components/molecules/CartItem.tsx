import React from 'react'
import { Card, Text, IconButton } from '../atoms'
import { Image } from '../atoms/Image'
import { formatBRL } from '@/lib/format'

interface CartItemProps {
  readonly id: string
  readonly title: string
  readonly price: number
  readonly imageUrl?: string
  readonly quantity: number
  readonly specialInstructions?: string
  readonly variantTitle?: string
  readonly onQuantityChange: (quantity: number) => void
  readonly onRemove: () => void
}

export const CartItem: React.FC<CartItemProps> = ({
  id: _id,
  title,
  price,
  imageUrl,
  quantity,
  specialInstructions,
  variantTitle,
  onQuantityChange,
  onRemove,
}) => {
  const formattedPrice = formatBRL(price)
  const lineTotal = formatBRL(price * quantity)

  return (
    <Card className="p-4">
      <div className="flex gap-4">
        {imageUrl && (
          <div className="w-20 h-20 flex-shrink-0">
            <Image
              src={imageUrl}
              alt={title}
              variant="thumbnail"
              width={80}
              height={80}
              className="!h-20 !w-20 rounded-sm"
            />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-charcoal-900 truncate">{title}</h3>
          {variantTitle && (
            <Text variant="small" textColor="secondary" className="text-smoke-400">
              {variantTitle}
            </Text>
          )}
          <Text variant="small" textColor="secondary">
            {formattedPrice} cada
          </Text>

          {specialInstructions && (
            <p className="text-xs text-smoke-400 mt-1 line-clamp-2">
              {specialInstructions}
            </p>
          )}

          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => onQuantityChange(Math.max(1, quantity - 1))}
                className="w-6 h-6 flex items-center justify-center rounded-sm border border-smoke-200 text-charcoal-700 hover:bg-smoke-100"
                aria-label="Diminuir quantidade"
              >
                −
              </button>
              <span className="w-8 text-center font-medium">{quantity}</span>
              <button
                onClick={() => onQuantityChange(quantity + 1)}
                className="w-6 h-6 flex items-center justify-center rounded-sm border border-smoke-200 text-charcoal-700 hover:bg-smoke-100"
                aria-label="Aumentar quantidade"
              >
                +
              </button>
            </div>

            <Text variant="body" className="font-semibold text-brand-600">
              {lineTotal}
            </Text>
          </div>
        </div>

        <IconButton
          variant="tertiary"
          size="md"
          icon="×"
          label="Remover do carrinho"
          onClick={onRemove}
          className="text-accent-red"
        />
      </div>
    </Card>
  )
}
