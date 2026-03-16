import { create } from 'zustand'

export interface UpsellSuggestion {
  productId: string
  title: string
  price: number
  imageUrl?: string
}

/** Generate a unique toast ID */
function generateToastId(): string {
  return `toast-${Date.now()}-${crypto.randomUUID()}`
}

type ToastType = 'success' | 'error' | 'warning' | 'info' | 'cart'
interface Toast { id: string; message: string; type: ToastType }

/** Build the new toasts array with the added toast */
function appendToast(toasts: Toast[], message: string, type: ToastType): { newToasts: Toast[]; id: string } {
  const id = generateToastId()
  return { newToasts: [...toasts, { id, message, type }], id }
}

/** Remove a toast by ID from the array */
function filterToast(toasts: Toast[], id: string): Toast[] {
  return toasts.filter((t) => t.id !== id)
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
  toasts: Toast[]

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
  addToast: (message: string, type: ToastType, duration?: number) => void
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
    let toastId = ''
    set((state) => {
      const { newToasts, id } = appendToast(state.toasts, message, type)
      toastId = id
      return { toasts: newToasts }
    })

    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({ toasts: filterToast(state.toasts, toastId) }))
      }, duration)
    }

    return toastId
  },

  removeToast: (id) =>
    set((state) => ({ toasts: filterToast(state.toasts, id) })),

  triggerUpsell: (categoryHandle) =>
    set({ upsellTriggerCategory: categoryHandle, upsellProduct: null }),

  setUpsellProduct: (product) =>
    set({ upsellProduct: product }),

  dismissUpsell: () =>
    set({ upsellTriggerCategory: null, upsellProduct: null }),
}))
