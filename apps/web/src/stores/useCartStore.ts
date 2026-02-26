import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProductDTO } from '@ibatexas/types'

export interface CartItem {
  id: string
  title: string
  price: number // centavos
  imageUrl?: string
  quantity: number
  specialInstructions?: string
  productType?: "food" | "frozen" | "merchandise"
  variantTitle?: string
}

interface CartState {
  items: CartItem[]
  deliveryType: 'delivery' | 'pickup' | 'dine-in' | null
  couponCode?: string
  selectedAddress?: string
  selectedTimeSlot?: string
  cep?: string
  deliveryFee?: number
  estimatedDeliveryMinutes?: number

  // Actions
  addItem: (product: ProductDTO, quantity: number, specialInstructions?: string) => void
  updateItem: (productId: string, updates: Partial<Pick<CartItem, 'quantity' | 'specialInstructions'>>) => void
  removeItem: (productId: string) => void
  clearCart: () => void
  setDeliveryType: (type: 'delivery' | 'pickup' | 'dine-in') => void
  setCouponCode: (code?: string) => void
  setSelectedAddress: (address?: string) => void
  setSelectedTimeSlot: (slot?: string) => void
  setCep: (cep: string) => void
  setDeliveryEstimate: (fee: number, minutes: number) => void

  // Computed
  getTotal: () => number
  getItemCount: () => number
  getCartType: () => "food" | "merchandise" | "mixed"
  hasMerchandise: () => boolean
  hasFood: () => boolean
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      deliveryType: null,

      addItem: (product, quantity, specialInstructions) =>
        set((state) => {
          const existing = state.items.find((item) => item.id === product.id)
          if (existing) {
            return {
              items: state.items.map((item) =>
                item.id === product.id
                  ? { ...item, quantity: item.quantity + quantity, specialInstructions }
                  : item
              ),
            }
          }
          return {
            items: [
              ...state.items,
              {
                id: product.id,
                title: product.title,
                price: product.price,
                imageUrl: product.imageUrl ?? undefined,
                quantity,
                specialInstructions,
                productType: product.productType,
                variantTitle: product.variants?.[0]?.title ?? undefined,
              },
            ],
          }
        }),

      updateItem: (productId, updates) =>
        set((state) => ({
          items: state.items.map((item) =>
            item.id === productId ? { ...item, ...updates } : item
          ),
        })),

      removeItem: (productId) =>
        set((state) => ({
          items: state.items.filter((item) => item.id !== productId),
        })),

      clearCart: () =>
        set({
          items: [],
          deliveryType: null,
          couponCode: undefined,
          selectedAddress: undefined,
          selectedTimeSlot: undefined,
          cep: undefined,
          deliveryFee: undefined,
        }),

      setDeliveryType: (type) => set({ deliveryType: type }),
      setCouponCode: (code) => set({ couponCode: code }),
      setSelectedAddress: (address) => set({ selectedAddress: address }),
      setSelectedTimeSlot: (slot) => set({ selectedTimeSlot: slot }),
      setCep: (cep) => set({ cep }),
      setDeliveryEstimate: (fee, minutes) =>
        set({ deliveryFee: fee, estimatedDeliveryMinutes: minutes }),

      getTotal: () => {
        return get().items.reduce((total, item) => total + item.price * item.quantity, 0)
      },

      getItemCount: () => {
        return get().items.reduce((count, item) => count + item.quantity, 0)
      },

      getCartType: () => {
        const items = get().items
        const hasFood = items.some(item => item.productType === "food" || item.productType === "frozen")
        const hasMerchandise = items.some(item => item.productType === "merchandise")
        
        if (hasFood && hasMerchandise) return "mixed"
        if (hasMerchandise) return "merchandise"
        return "food"
      },

      hasMerchandise: () => {
        return get().items.some(item => item.productType === "merchandise")
      },

      hasFood: () => {
        return get().items.some(item => item.productType === "food" || item.productType === "frozen")
      },
    }),
    {
      name: 'cart_v1',
      version: 3,
      migrate: (persistedState: any, version: number) => {
        if (version < 3) {
          // Default existing items to "food" productType
          if (persistedState?.items) {
            persistedState.items = persistedState.items.map((item: any) => ({
              ...item,
              productType: item.productType ?? "food"
            }))
          }
        }
        return persistedState
      },
    }
  )
)
