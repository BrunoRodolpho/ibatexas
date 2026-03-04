/**
 * Wishlist / Favorites store — persisted to localStorage.
 * Uses Zustand for consistent state management with the rest of the app.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface WishlistState {
  /** Set of favorited product IDs */
  items: string[]

  /** Toggle a product in/out of the wishlist */
  toggle: (productId: string) => void

  /** Check if a product is in the wishlist */
  isFavorite: (productId: string) => boolean

  /** Clear the entire wishlist */
  clear: () => void
}

export const useWishlistStore = create<WishlistState>()(
  persist(
    (set, get) => ({
      items: [],

      toggle: (productId) => {
        const current = get().items
        if (current.includes(productId)) {
          set({ items: current.filter((id) => id !== productId) })
        } else {
          set({ items: [...current, productId] })
        }
      },

      isFavorite: (productId) => get().items.includes(productId),

      clear: () => set({ items: [] }),
    }),
    {
      name: 'wishlist_v1',
    },
  ),
)
