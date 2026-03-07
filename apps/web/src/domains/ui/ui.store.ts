import { create } from 'zustand'

export interface UpsellSuggestion {
  productId: string
  title: string
  price: number
  imageUrl?: string
}

interface UIState {
  isMobileNavOpen: boolean
  isChatOpen: boolean
  isCartDrawerOpen: boolean
  selectedFilters: {
    tags: string[]
    category?: string
    sort?: string
  }
  toasts: Array<{ id: string; message: string; type: 'success' | 'error' | 'warning' | 'info' | 'cart' }>

  /** Category handle that triggered the upsell lookup */
  upsellTriggerCategory: string | null
  /** Resolved upsell product to display */
  upsellProduct: UpsellSuggestion | null

  // Actions
  toggleMobileNav: () => void
  toggleChat: () => void
  setMobileNav: (isOpen: boolean) => void
  setChat: (isOpen: boolean) => void
  openCartDrawer: () => void
  closeCartDrawer: () => void
  toggleCartDrawer: () => void
  setFilters: (filters: UIState['selectedFilters']) => void
  resetFilters: () => void
  addToast: (message: string, type: 'success' | 'error' | 'warning' | 'info' | 'cart', duration?: number) => void
  removeToast: (id: string) => void
  triggerUpsell: (categoryHandle: string) => void
  setUpsellProduct: (product: UpsellSuggestion) => void
  dismissUpsell: () => void
}

export const useUIStore = create<UIState>((set) => ({
  isMobileNavOpen: false,
  isChatOpen: false,
  isCartDrawerOpen: false,
  selectedFilters: {
    tags: [],
  },
  toasts: [],
  upsellTriggerCategory: null,
  upsellProduct: null,

  toggleMobileNav: () =>
    set((state) => ({ isMobileNavOpen: !state.isMobileNavOpen })),

  toggleChat: () =>
    set((state) => ({ isChatOpen: !state.isChatOpen })),

  setMobileNav: (isOpen) => set({ isMobileNavOpen: isOpen }),
  setChat: (isOpen) => set({ isChatOpen: isOpen }),

  openCartDrawer: () => set({ isCartDrawerOpen: true }),
  closeCartDrawer: () => set({ isCartDrawerOpen: false }),
  toggleCartDrawer: () => set((state) => ({ isCartDrawerOpen: !state.isCartDrawerOpen })),

  setFilters: (filters) =>
    set((state) => ({
      selectedFilters: { ...state.selectedFilters, ...filters },
    })),

  resetFilters: () =>
    set({
      selectedFilters: {
        tags: [],
      },
    }),

  addToast: (message, type, duration = 5000) => {
    const id = `toast-${Date.now()}-${Math.random()}`
    set((state) => ({
      toasts: [...state.toasts, { id, message, type }],
    }))

    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }))
      }, duration)
    }

    return id
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  triggerUpsell: (categoryHandle) =>
    set({ upsellTriggerCategory: categoryHandle, upsellProduct: null }),

  setUpsellProduct: (product) =>
    set({ upsellProduct: product }),

  dismissUpsell: () =>
    set({ upsellTriggerCategory: null, upsellProduct: null }),
}))
