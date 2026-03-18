import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'
import {
  resolveVariant, resolveCartItemId, buildCartItem, migrateCartState,
  getCartType as getCartTypePure, hasMerchandise as hasMerchandisePure, hasFood as hasFoodPure,
} from './cart.logic'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || ''

/** Ensure a Medusa cart exists; create one if needed. Non-blocking. */
async function ensureMedusaCart(
  getMedusaCartId: () => string | undefined,
  setMedusaCartId: (id: string) => void,
): Promise<void> {
  if (getMedusaCartId()) return
  try {
    const res = await fetch(`${API_BASE}/api/cart`, { method: 'POST', credentials: 'include' })
    if (res.ok) {
      const data = await res.json() as { cart?: { id: string } }
      if (data.cart?.id) setMedusaCartId(data.cart.id)
    }
  } catch {
    // Non-critical — cart will be created on checkout fallback
  }
}

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
  getCartType: () => "food" | "merchandise" | "mixed" | "empty"
  hasMerchandise: () => boolean
  hasFood: () => boolean
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      deliveryType: null,

      addItem: (product, quantity, specialInstructions, variant) => {
        // Eagerly create Medusa cart on first add (non-blocking)
        void ensureMedusaCart(() => get().medusaCartId, (id) => set({ medusaCartId: id }))

        set((state) => {
          const selectedVariant = resolveVariant(product, variant)
          const itemId = resolveCartItemId(product.id, selectedVariant?.id)
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
            items: [...state.items, buildCartItem(product, selectedVariant, quantity, specialInstructions)],
          }
        })
      },

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
          estimatedDeliveryMinutes: undefined,
          lastModifiedAt: undefined,
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

      getCartType: () => getCartTypePure(get().items),
      hasMerchandise: () => hasMerchandisePure(get().items),
      hasFood: () => hasFoodPure(get().items),
    }),
    {
      name: 'cart_v1',
      version: 4,
      migrate: (persistedState, version) => migrateCartState(persistedState, version),
    }
  )
)
