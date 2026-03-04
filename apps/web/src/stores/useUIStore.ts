import { create } from 'zustand'

interface UIState {
  isMobileNavOpen: boolean
  isChatOpen: boolean
  isCartDrawerOpen: boolean
  selectedFilters: {
    tags: string[]
    category?: string
    priceRange?: [number, number]
    sort?: string
  }
  toasts: Array<{ id: string; message: string; type: 'success' | 'error' | 'warning' | 'info' }>

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
  addToast: (message: string, type: 'success' | 'error' | 'warning' | 'info', duration?: number) => void
  removeToast: (id: string) => void
}

export const useUIStore = create<UIState>((set) => ({
  isMobileNavOpen: false,
  isChatOpen: false,
  isCartDrawerOpen: false,
  selectedFilters: {
    tags: [],
  },
  toasts: [],

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
}))
