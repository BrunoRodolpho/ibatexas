/**
 * Recently viewed products — persisted in sessionStorage.
 * Stores last 10 viewed product IDs for the current browser session.
 */

'use client'

import { useEffect, useState, useCallback } from 'react'

const STORAGE_KEY = 'ibx_recently_viewed'
const MAX_ITEMS = 10

/**
 * Hook to manage recently viewed products.
 * Uses sessionStorage so the list persists within a tab but resets on close.
 */
export function useRecentlyViewed() {
  const [items, setItems] = useState<string[]>([])

  // Load from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY)
      if (stored) {
        setItems(JSON.parse(stored))
      }
    } catch {
      // Silent fail
    }
  }, [])

  const addProduct = useCallback((productId: string) => {
    setItems((prev) => {
      const filtered = prev.filter((id) => id !== productId)
      const updated = [productId, ...filtered].slice(0, MAX_ITEMS)
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
      } catch {
        // Storage full — ignore
      }
      return updated
    })
  }, [])

  const getIds = useCallback(
    (exclude?: string) => items.filter((id) => id !== exclude),
    [items],
  )

  return { items, addProduct, getIds }
}
