import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'

export interface CartItem {
  id: string // productId:variantId composite key for unique cart entries
  productId: string
  title: string
  price: number // centavos
  imageUrl?: string
  quantity: number
  specialInstructions?: string
  productType?: "food" | "frozen" | "merchandise"
  variantId?: string
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
  /** Medusa cart ID — set when a cart is created via /api/cart */
  medusaCartId?: string
  /** Timestamp (ms) of last cart modification — used for abandonment nudge */
  lastModifiedAt?: number

  // Actions
  addItem: (product: ProductDTO, quantity: number, specialInstructions?: string, variant?: ProductVariant) => void
  updateItem: (itemId: string, updates: Partial<Pick<CartItem, 'quantity' | 'specialInstructions'>>) => void
  removeItem: (itemId: string) => void
  clearCart: () => void
  setDeliveryType: (type: 'delivery' | 'pickup' | 'dine-in') => void
  setCouponCode: (code?: string) => void
  setSelectedAddress: (address?: string) => void
  setSelectedTimeSlot: (slot?: string) => void
  setCep: (cep: string) => void
  setDeliveryEstimate: (fee: number, minutes: number) => void
  setMedusaCartId: (cartId: string) => void
  clearMedusaCartId: () => void

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

      addItem: (product, quantity, specialInstructions, variant) =>
        set((state) => {
          const selectedVariant = variant ?? product.variants?.[0]
          const itemId = selectedVariant?.id
            ? `${product.id}:${selectedVariant.id}`
            : product.id
          const itemPrice = selectedVariant?.price ?? product.price
          const now = Date.now()

          const existing = state.items.find((item) => item.id === itemId)
          if (existing) {
            return {
              lastModifiedAt: now,
              items: state.items.map((item) =>
                item.id === itemId
                  ? { ...item, quantity: item.quantity + quantity, specialInstructions }
                  : item
              ),
            }
          }
          return {
            lastModifiedAt: now,
            items: [
              ...state.items,
              {
                id: itemId,
                productId: product.id,
                title: product.title,
                price: itemPrice,
                imageUrl: product.imageUrl ?? undefined,
                quantity,
                specialInstructions,
                productType: product.productType,
                variantId: selectedVariant?.id ?? undefined,
                variantTitle: selectedVariant?.title ?? undefined,
              },
            ],
          }
        }),

      updateItem: (itemId, updates) =>
        set((state) => ({
          lastModifiedAt: Date.now(),
          items: state.items.map((item) =>
            item.id === itemId ? { ...item, ...updates } : item
          ),
        })),

      removeItem: (itemId) =>
        set((state) => ({
          lastModifiedAt: Date.now(),
          items: state.items.filter((item) => item.id !== itemId),
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
          medusaCartId: undefined,
        }),

      setDeliveryType: (type) => set({ deliveryType: type }),
      setCouponCode: (code) => set({ couponCode: code }),
      setSelectedAddress: (address) => set({ selectedAddress: address }),
      setSelectedTimeSlot: (slot) => set({ selectedTimeSlot: slot }),
      setCep: (cep) => set({ cep }),
      setDeliveryEstimate: (fee, minutes) =>
        set({ deliveryFee: fee, estimatedDeliveryMinutes: minutes }),
      setMedusaCartId: (cartId) => set({ medusaCartId: cartId }),
      clearMedusaCartId: () => set({ medusaCartId: undefined }),

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
      version: 4,
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as Record<string, unknown>
        if (version < 3) {
          // Default existing items to "food" productType
          if (Array.isArray(state?.items)) {
            state.items = (state.items as Record<string, unknown>[]).map((item) => ({
              ...item,
              productType: (item as Record<string, unknown>).productType ?? "food"
            }))
          }
        }
        if (version < 4) {
          // Migrate: add productId field (was missing), ensure variantId exists
          if (Array.isArray(state?.items)) {
            state.items = (state.items as Record<string, unknown>[]).map((item) => ({
              ...item,
              productId: (item as Record<string, unknown>).productId ?? (item as Record<string, unknown>).id,
              variantId: (item as Record<string, unknown>).variantId ?? undefined,
            }))
          }
        }
        return state
      },
    }
  )
)
