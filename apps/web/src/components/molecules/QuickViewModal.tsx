'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sheet } from './Modal'
import { Button, LinkButton, Badge, Text } from '../atoms'
import { QuantitySelector } from './QuantitySelector'
import NextImage from 'next/image'
import { Star, Users, Scale } from 'lucide-react'
import { formatBRL, formatRating } from '@/lib/format'
import { tagToBadgeVariant } from '@/domains/product'
import { BLUR_PLACEHOLDER } from '@/lib/constants'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { track } from '@/domains/analytics'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'

interface QuickViewModalProps {
  readonly product: ProductDTO | null
  readonly isOpen: boolean
  readonly onClose: () => void
}

/**
 * Product Quick View modal — overlays on ProductCard click.
 * Shows image + price + variant selector + add-to-cart without full PDP navigation.
 */
export function QuickViewModal({ product, isOpen, onClose }: QuickViewModalProps) {
  const t = useTranslations()
  const addToCart = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()
  const [quantity, setQuantity] = useState(1)
  const [selectedVariantId, setSelectedVariantId] = useState<string>('')
  const [isAdding, setIsAdding] = useState(false)

  if (!product) return null

  const selectedVariant: ProductVariant | undefined = selectedVariantId
    ? product.variants.find((v) => v.id === selectedVariantId)
    : product.variants[0]

  const currentPrice = selectedVariant?.price || product.price
  const displayImage = product.imageUrl || product.images?.[0]

  const handleAddToCart = async () => {
    if (!selectedVariant) return

    setIsAdding(true)
    try {
      addToCart(product, quantity, undefined, selectedVariant)
      track('add_to_cart', {
        productId: product.id,
        variantId: selectedVariant.id,
        quantity,
        source: 'quick_view',
      })
      addToast(t('toast.added_to_cart'), 'cart')
      onClose()
    } catch {
      addToast(t('toast.add_to_cart_error'), 'error')
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title={product.title}
      position="bottom"
      footer={
        <div className="space-y-3">
          <Button
            onClick={handleAddToCart}
            disabled={!selectedVariant || isAdding}
            isLoading={isAdding}
            className="w-full"
            size="lg"
          >
            {t('product.add_to_cart')} — {formatBRL(currentPrice * quantity)}
          </Button>
          <LinkButton
            href={`/loja/produto/${product.id}`}
            variant="tertiary"
            size="md"
            className="w-full"
            onClick={onClose}
          >
            {t('quick_view.view_details')}
          </LinkButton>
        </div>
      }
    >
      <div className="flex gap-4">
        {/* Product Image */}
        {displayImage && (
          <div className="w-32 h-32 flex-shrink-0 rounded-card overflow-hidden bg-smoke-100 relative">
            <NextImage
              src={displayImage}
              alt={product.title}
              fill
              placeholder="blur"
              blurDataURL={BLUR_PLACEHOLDER}
              className="object-cover"
              sizes="128px"
            />
          </div>
        )}

        <div className="flex-1 min-w-0">
          {/* Tags */}
          {product.tags && product.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {product.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant={tagToBadgeVariant(tag)}>
                  {tag.replaceAll("_", " ")}
                </Badge>
              ))}
            </div>
          )}

          {/* Price */}
          <p className="text-lg font-semibold text-charcoal-900 tabular-nums">
            {formatBRL(currentPrice)}
          </p>

          {/* Rating */}
          {product.rating && product.rating > 0 && (
            <div className="flex items-center gap-1 mt-1">
              <Star className="w-3 h-3 fill-brand-500 text-brand-500" />
              <span className="text-xs text-smoke-400">
                {formatRating(product.rating)}
                {product.reviewCount ? ` (${product.reviewCount})` : ''}
              </span>
            </div>
          )}

          {/* Serving / weight info */}
          {(product.servings || product.weight) && (
            <div className="flex items-center gap-2 mt-1.5 text-[11px] text-smoke-400">
              {product.servings && (
                <span className="inline-flex items-center gap-0.5">
                  <Users className="w-3 h-3" />
                  {t('product.serves', { count: product.servings })}
                </span>
              )}
              {product.servings && product.weight && <span>·</span>}
              {product.weight && (
                <span className="inline-flex items-center gap-0.5">
                  <Scale className="w-3 h-3" />
                  {product.weight}
                </span>
              )}
            </div>
          )}

          {/* Description snippet */}
          {product.description && (
            <p className="text-xs text-smoke-400 mt-2 line-clamp-2">
              {product.description}
            </p>
          )}
        </div>
      </div>

      {/* Variant selection */}
      {product.variants.length > 1 && (
        <div className="mt-4">
          <Text variant="small" weight="medium" className="mb-2">
            {t('product.variants')}
          </Text>
          <div className="flex flex-wrap gap-2">
            {product.variants.map((variant) => {
              const isSelected = variant.id === (selectedVariantId || product.variants[0]?.id)
              return (
                <button
                  key={variant.id}
                  onClick={() => setSelectedVariantId(variant.id)}
                  className={`px-3 py-1.5 text-xs rounded-sm border transition-all duration-300 ${
                    isSelected
                      ? 'border-charcoal-900 bg-charcoal-900 text-smoke-50'
                      : 'border-smoke-200 text-charcoal-700 hover:border-smoke-300'
                  }`}
                >
                  {variant.title || 'Único'} — {formatBRL(variant.price)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Quantity */}
      <div className="mt-4 flex items-center gap-3">
        <Text variant="small" weight="medium">{t('product.quantity')}</Text>
        <QuantitySelector
          quantity={quantity}
          onQuantityChange={setQuantity}
          min={1}
          max={99}
          size="sm"
        />
      </div>
    </Sheet>
  )
}
