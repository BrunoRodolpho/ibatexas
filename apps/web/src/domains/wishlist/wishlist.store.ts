/**
 * Wishlist / Favorites store — persisted to localStorage.
 * Uses Zustand for consistent state management with the rest of the app.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface WishlistState {
  /** Set of favorited product IDs */
  items: string[]

  /** True once Zustand persist has rehydrated from localStorage. SSR pages
   *  must wait on this before deciding to show an empty state, otherwise
   *  the first paint flashes "no favorites" before localStorage loads. */
  _hydrated: boolean

  /** Setter exposed so onRehydrateStorage can route the flip through set()
   *  and notify React subscribers. Direct mutation (state._hydrated = true)
   *  does NOT trigger re-renders — that was the bug behind /lista-desejos
   *  rendering its empty state even when the wishlist had items. */
  setHydrated: (h: boolean) => void

  /** Toggle a product in/out of the wishlist */
  toggle: (productId: string) => void

  /** Check if a product is in the wishlist (non-reactive — for handlers) */
  isFavorite: (productId: string) => boolean

  /** Clear the entire wishlist */
  clear: () => void
}

export const useWishlistStore = create<WishlistState>()(
  persist(
    (set, get) => ({
      items: [],
      _hydrated: false,

      setHydrated: (h) => set({ _hydrated: h }),

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
      // Only persist `items` — `_hydrated` is a runtime flag.
      partialize: (state) => ({ items: state.items }),
      onRehydrateStorage: () => (state) => {
        // Route through the setter so subscribers see the change.
        state?.setHydrated(true)
      },
    },
  ),
)
