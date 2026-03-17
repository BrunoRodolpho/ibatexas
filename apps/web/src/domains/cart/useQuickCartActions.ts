'use client'

import { useState, useCallback } from 'react'
import { track } from '@/domains/analytics'
import { useCartStore } from '@/domains/cart'

/**
 * Shared cart interaction logic for product carousel sections.
 * Encapsulates add/increment/decrement with analytics tracking.
 */
export function useQuickCartActions(
  onAddToCart: ((productId: string) => void) | undefined,
  analyticsSource: string,
) {
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())

  const cartItems = useCartStore((s) => s.items)
  const updateItem = useCartStore((s) => s.updateItem)
  const removeItem = useCartStore((s) => s.removeItem)

  const getCartQuantity = useCallback(
    (productId: string) =>
      cartItems.filter((item) => item.productId === productId).reduce((sum, item) => sum + item.quantity, 0),
    [cartItems],
  )
  const getCartItemId = useCallback(
    (productId: string) => cartItems.find((item) => item.productId === productId)?.id,
    [cartItems],
  )

  const handleAdd = useCallback((productId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quick_add_clicked', { productId, source: analyticsSource })
    onAddToCart?.(productId)
    setAddedIds((prev) => new Set(prev).add(productId))
    setTimeout(() => {
      setAddedIds((prev) => {
        const next = new Set(prev)
        next.delete(productId)
        return next
      })
    }, 2000)
  }, [onAddToCart, analyticsSource])

  const handleIncrement = useCallback((productId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const qty = getCartQuantity(productId)
    track('quantity_changed_inline', { productId, action: 'increment', quantity: qty + 1 })
    const itemId = getCartItemId(productId)
    if (itemId) updateItem(itemId, { quantity: qty + 1 })
  }, [getCartQuantity, getCartItemId, updateItem])

  const handleDecrement = useCallback((productId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const qty = getCartQuantity(productId)
    const itemId = getCartItemId(productId)
    if (qty <= 1) {
      track('quantity_changed_inline', { productId, action: 'remove', quantity: 0 })
      if (itemId) removeItem(itemId)
    } else {
      track('quantity_changed_inline', { productId, action: 'decrement', quantity: qty - 1 })
      if (itemId) updateItem(itemId, { quantity: qty - 1 })
    }
  }, [getCartQuantity, getCartItemId, updateItem, removeItem])

  return { addedIds, getCartQuantity, handleAdd, handleIncrement, handleDecrement }
}
