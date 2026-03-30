'use client'

import { useState, useCallback } from 'react'
import { formatBRL } from '@/lib/format'
import { track } from '@/domains/analytics'

import { ProductCardVertical } from './ProductCardVertical'
import { ProductCardHorizontal } from './ProductCardHorizontal'
import { resolvePriorityTag, computeDiscount } from './types'
import type { ProductCardProps } from './types'

export type { ProductCardProps }

export const ProductCard = ({
  id,
  title,
  subtitle,
  imageUrl,
  images,
  price,
  compareAtPrice,
  variantCount,
  rating,
  reviewCount,
  tags,
  weight,
  servings,
  stockCount,
  availabilityWindow,
  description,
  isBundle,
  bundleServings,
  href,
  onAddToCart,
  priority,
  cartQuantity = 0,
  onUpdateQuantity,
  onRemoveFromCart,
  ordersToday,
  variant = 'vertical',
}: ProductCardProps) => {
  const [isAdded, setIsAdded] = useState(false)

  // ── Pre-computed values ──────────────────────────────────────────
  const priceFormatted = formatBRL(price)
  const hasMultipleVariants = (variantCount ?? 0) > 1
  const displayImage = imageUrl || images?.[0] || null
  const linkHref = href || `/products/${id}`
  const priorityTag = resolvePriorityTag(tags)
  const { hasDiscount, discountPercent } = computeDiscount(price, compareAtPrice)
  const hoverImage = images && images.length >= 2 && images[1] !== displayImage ? images[1] : null

  // ── Event handlers ───────────────────────────────────────────────
  const handleQuickAdd = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quick_add_clicked', { productId: id, source: 'listing' })
    onAddToCart?.()
    setIsAdded(true)
    setTimeout(() => setIsAdded(false), 2000)
  }, [id, onAddToCart])

  const handleIncrement = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quantity_changed_inline', { productId: id, action: 'increment', quantity: cartQuantity + 1 })
    onUpdateQuantity?.(cartQuantity + 1)
  }, [id, cartQuantity, onUpdateQuantity])

  const handleDecrement = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (cartQuantity <= 1) {
      track('quantity_changed_inline', { productId: id, action: 'remove', quantity: 0 })
      onRemoveFromCart?.()
    } else {
      track('quantity_changed_inline', { productId: id, action: 'decrement', quantity: cartQuantity - 1 })
      onUpdateQuantity?.(cartQuantity - 1)
    }
  }, [id, cartQuantity, onUpdateQuantity, onRemoveFromCart])

  const handleCardClick = () => {
    track('product_card_clicked', { productId: id, source: 'listing' })
  }

  // ── Structured data objects ──────────────────────────────────────
  const data = {
    id, title, subtitle, imageUrl: imageUrl ?? '', images, price,
    compareAtPrice, rating, reviewCount, tags, weight, servings,
    stockCount, availabilityWindow, isBundle, bundleServings,
    href: linkHref, ordersToday,
  }

  const cart = { quantity: cartQuantity }

  const callbacks = { onAddToCart, onUpdateQuantity, onRemoveFromCart }

  const computed = {
    displayImage, linkHref, priorityTag, hasDiscount,
    discountPercent, priceFormatted, hasMultipleVariants, hoverImage,
  }

  const handlers = { handleQuickAdd, handleIncrement, handleDecrement, handleCardClick }

  // ── Delegate to variant ──────────────────────────────────────────
  if (variant === 'horizontal') {
    return (
      <ProductCardHorizontal
        data={data}
        cart={cart}
        callbacks={callbacks}
        priority={priority}
        computed={computed}
        handlers={handlers}
      />
    )
  }

  return (
    <ProductCardVertical
      data={data}
      cart={cart}
      callbacks={callbacks}
      priority={priority}
      description={description}
      variantCount={variantCount}
      computed={computed}
      handlers={handlers}
      isAdded={isAdded}
    />
  )
}
