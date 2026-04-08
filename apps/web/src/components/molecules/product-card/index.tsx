'use client'

import { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { formatBRL } from '@/lib/format'
import { track } from '@/domains/analytics'
import { useUIStore } from '@/domains/ui'

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
  const t = useTranslations()
  const addToast = useUIStore((s) => s.addToast)

  // ── Pre-computed values ──────────────────────────────────────────
  const priceFormatted = formatBRL(price)
  const hasMultipleVariants = (variantCount ?? 0) > 1
  const displayImage = imageUrl || images?.[0] || null
  const linkHref = href || `/loja/produto/${id}`
  const priorityTag = resolvePriorityTag(tags)
  const { hasDiscount, discountPercent } = computeDiscount(price, compareAtPrice)
  const hoverImage = images && images.length >= 2 && images[1] !== displayImage ? images[1] : null

  // ── Event handlers ───────────────────────────────────────────────
  // Quick-add is async-safe: we await whatever onAddToCart returns (sync or
  // promise) and only flash the success state if it resolves. A silent failure
  // here (audit P0-1) would tell the user "added ✓" when the cart is still
  // empty — classic conversion killer surfaced only at checkout.
  const handleQuickAdd = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quick_add_clicked', { productId: id, source: 'listing' })
    try {
      await Promise.resolve(onAddToCart?.())
      setIsAdded(true)
      setTimeout(() => setIsAdded(false), 2000)
    } catch (err) {
      track('quick_add_failed', {
        productId: id,
        source: 'listing',
        reason: err instanceof Error ? err.message : 'unknown',
      })
      addToast(t('toast.add_to_cart_error'), 'error')
    }
  }, [id, onAddToCart, addToast, t])

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
