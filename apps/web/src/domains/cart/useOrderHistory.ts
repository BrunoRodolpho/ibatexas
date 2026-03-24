import { useState, useEffect } from 'react'

const STORAGE_KEY = 'ibx_last_order'

export interface LastOrderItem {
  productId: string
  title: string
  price: number
  imageUrl?: string
  quantity: number
  variantId?: string
  variantTitle?: string
}

export interface LastOrder {
  items: LastOrderItem[]
  total: number
  orderId: string
  date: string
}

export function useOrderHistory() {
  const [lastOrder, setLastOrder] = useState<LastOrder | null>(null)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed: LastOrder = JSON.parse(stored)
        setLastOrder(parsed) // eslint-disable-line react-hooks/set-state-in-effect -- SSR-safe storage read requires effect
      }
    } catch {
      // localStorage not available
    }
  }, [])

  const saveOrder = (order: LastOrder) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
      setLastOrder(order)
    } catch {
      // localStorage not available
    }
  }

  return { lastOrder, saveOrder }
}
