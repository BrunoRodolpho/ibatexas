/**
 * Cart store tests — pure logic only, no DOM.
 *
 * Tests zustand store actions via getState()/setState().
 * The persist middleware is transparent in tests because
 * we reset state via setState() before each test.
 */

const mockGetApiBase = vi.hoisted(() => vi.fn(() => 'http://localhost:3000'))

vi.mock('@/lib/api', () => ({
  getApiBase: mockGetApiBase,
}))

vi.mock('@ibatexas/tools/api', () => ({
  getApiBase: mockGetApiBase,
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'
import { useCartStore } from '../cart.store'

// ── Fixtures ────────────────────────────────────────────────────────────

function createProduct(overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: 'prod_1',
    title: 'Costela Defumada',
    description: null,
    price: 8900,
    imageUrl: 'https://img.test/costela.jpg',
    images: [],
    tags: [],
    availabilityWindow: 'sempre' as ProductDTO['availabilityWindow'],
    allergens: [],
    variants: [],
    productType: 'food' as ProductDTO['productType'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function createVariant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: 'var_1',
    title: 'Padrão',
    sku: null,
    price: 8900,
    ...overrides,
  }
}

function resetStore() {
  useCartStore.setState({
    items: [],
    deliveryType: 'delivery',
    couponCode: undefined,
    selectedAddress: undefined,
    selectedTimeSlot: undefined,
    cep: undefined,
    deliveryFee: undefined,
    estimatedDeliveryMinutes: undefined,
    lastModifiedAt: undefined,
    medusaCartId: undefined,
  })
}

// ── Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})

// ── addItem ─────────────────────────────────────────────────────────────

describe('addItem', () => {
  it('adds a new item to an empty cart', () => {
    const product = createProduct()
    useCartStore.getState().addItem(product, 1)

    const { items } = useCartStore.getState()
    expect(items).toHaveLength(1)
    expect(items[0].productId).toBe('prod_1')
    expect(items[0].title).toBe('Costela Defumada')
    expect(items[0].price).toBe(8900)
    expect(items[0].quantity).toBe(1)
  })

  it('uses product price (integer centavos) not floats', () => {
    const product = createProduct({ price: 15900 })
    useCartStore.getState().addItem(product, 2)

    const { items } = useCartStore.getState()
    expect(items[0].price).toBe(15900)
    // Total should be price * quantity
    expect(useCartStore.getState().getTotal()).toBe(31800)
  })

  it('increments quantity when adding same product again', () => {
    const product = createProduct()
    useCartStore.getState().addItem(product, 1)
    useCartStore.getState().addItem(product, 3)

    const { items } = useCartStore.getState()
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(4)
  })

  it('updates specialInstructions when adding same product again', () => {
    const product = createProduct()
    useCartStore.getState().addItem(product, 1, 'Sem molho')
    useCartStore.getState().addItem(product, 1, 'Com molho extra')

    const { items } = useCartStore.getState()
    expect(items[0].specialInstructions).toBe('Com molho extra')
  })

  it('adds different products as separate items', () => {
    const product1 = createProduct({ id: 'prod_1', title: 'Costela' })
    const product2 = createProduct({ id: 'prod_2', title: 'Brisket' })
    useCartStore.getState().addItem(product1, 1)
    useCartStore.getState().addItem(product2, 2)

    const { items } = useCartStore.getState()
    expect(items).toHaveLength(2)
    expect(items[0].productId).toBe('prod_1')
    expect(items[1].productId).toBe('prod_2')
  })

  it('uses variant price when variant is provided', () => {
    const product = createProduct({ variants: [createVariant({ id: 'v1', price: 12900 })] })
    const variant = createVariant({ id: 'v1', price: 12900 })
    useCartStore.getState().addItem(product, 1, undefined, variant)

    const { items } = useCartStore.getState()
    expect(items[0].price).toBe(12900)
    expect(items[0].variantId).toBe('v1')
    expect(items[0].id).toBe('prod_1:v1')
  })

  it('same product with different variants are separate cart items', () => {
    const product = createProduct({
      variants: [
        createVariant({ id: 'v_sm', title: 'Pequena', price: 5900 }),
        createVariant({ id: 'v_lg', title: 'Grande', price: 9900 }),
      ],
    })
    useCartStore.getState().addItem(product, 1, undefined, createVariant({ id: 'v_sm', price: 5900 }))
    useCartStore.getState().addItem(product, 1, undefined, createVariant({ id: 'v_lg', price: 9900 }))

    const { items } = useCartStore.getState()
    expect(items).toHaveLength(2)
    expect(items[0].id).toBe('prod_1:v_sm')
    expect(items[1].id).toBe('prod_1:v_lg')
  })

  it('falls back to first product variant when none specified', () => {
    const firstVariant = createVariant({ id: 'v_default', price: 7900, title: 'Padrão' })
    const product = createProduct({ variants: [firstVariant] })
    useCartStore.getState().addItem(product, 1)

    const { items } = useCartStore.getState()
    expect(items[0].variantId).toBe('v_default')
    expect(items[0].price).toBe(7900)
  })

  it('sets lastModifiedAt timestamp', () => {
    const product = createProduct()
    useCartStore.getState().addItem(product, 1)
    expect(useCartStore.getState().lastModifiedAt).toBeTypeOf('number')
  })

  it('preserves productType on cart item', () => {
    const food = createProduct({ productType: 'food' as ProductDTO['productType'] })
    const merch = createProduct({ id: 'prod_2', productType: 'merchandise' as ProductDTO['productType'] })
    useCartStore.getState().addItem(food, 1)
    useCartStore.getState().addItem(merch, 1)

    const { items } = useCartStore.getState()
    expect(items[0].productType).toBe('food')
    expect(items[1].productType).toBe('merchandise')
  })
})

// ── updateItem ──────────────────────────────────────────────────────────

describe('updateItem', () => {
  it('updates quantity of an existing item', () => {
    const product = createProduct()
    useCartStore.getState().addItem(product, 1)

    useCartStore.getState().updateItem('prod_1', { quantity: 5 })
    expect(useCartStore.getState().items[0].quantity).toBe(5)
  })

  it('updates specialInstructions of an existing item', () => {
    const product = createProduct()
    useCartStore.getState().addItem(product, 1)

    useCartStore.getState().updateItem('prod_1', { specialInstructions: 'Bem passada' })
    expect(useCartStore.getState().items[0].specialInstructions).toBe('Bem passada')
  })

  it('updates both quantity and specialInstructions at once', () => {
    const product = createProduct()
    useCartStore.getState().addItem(product, 1)

    useCartStore.getState().updateItem('prod_1', { quantity: 3, specialInstructions: 'Extra molho' })
    const item = useCartStore.getState().items[0]
    expect(item.quantity).toBe(3)
    expect(item.specialInstructions).toBe('Extra molho')
  })

  it('does not affect other items', () => {
    useCartStore.getState().addItem(createProduct({ id: 'p1', title: 'Costela' }), 2)
    useCartStore.getState().addItem(createProduct({ id: 'p2', title: 'Brisket' }), 1)

    useCartStore.getState().updateItem('p1', { quantity: 10 })
    expect(useCartStore.getState().items[0].quantity).toBe(10)
    expect(useCartStore.getState().items[1].quantity).toBe(1) // untouched
  })

  it('silently ignores unknown item IDs', () => {
    useCartStore.getState().addItem(createProduct(), 1)
    useCartStore.getState().updateItem('nonexistent', { quantity: 99 })
    expect(useCartStore.getState().items).toHaveLength(1)
    expect(useCartStore.getState().items[0].quantity).toBe(1)
  })

  it('updates lastModifiedAt', () => {
    useCartStore.getState().addItem(createProduct(), 1)
    const before = useCartStore.getState().lastModifiedAt!
    // Small delay to ensure different timestamp
    useCartStore.getState().updateItem('prod_1', { quantity: 2 })
    expect(useCartStore.getState().lastModifiedAt).toBeGreaterThanOrEqual(before)
  })
})

// ── removeItem ──────────────────────────────────────────────────────────

describe('removeItem', () => {
  it('removes an item by ID', () => {
    useCartStore.getState().addItem(createProduct({ id: 'p1' }), 1)
    useCartStore.getState().addItem(createProduct({ id: 'p2' }), 2)

    useCartStore.getState().removeItem('p1')
    const { items } = useCartStore.getState()
    expect(items).toHaveLength(1)
    expect(items[0].productId).toBe('p2')
  })

  it('results in empty cart when last item removed', () => {
    useCartStore.getState().addItem(createProduct(), 1)
    useCartStore.getState().removeItem('prod_1')
    expect(useCartStore.getState().items).toHaveLength(0)
  })

  it('silently ignores unknown item IDs', () => {
    useCartStore.getState().addItem(createProduct(), 1)
    useCartStore.getState().removeItem('ghost')
    expect(useCartStore.getState().items).toHaveLength(1)
  })

  it('updates lastModifiedAt', () => {
    useCartStore.getState().addItem(createProduct(), 1)
    useCartStore.getState().removeItem('prod_1')
    expect(useCartStore.getState().lastModifiedAt).toBeTypeOf('number')
  })
})

// ── clearCart ────────────────────────────────────────────────────────────

describe('clearCart', () => {
  it('removes all items and resets delivery settings', () => {
    useCartStore.getState().addItem(createProduct({ id: 'p1' }), 1)
    useCartStore.getState().addItem(createProduct({ id: 'p2' }), 2)
    useCartStore.getState().setDeliveryType('delivery')
    useCartStore.getState().setCouponCode('PROMO10')
    useCartStore.getState().setSelectedAddress('Rua Texas, 123')
    useCartStore.getState().setSelectedTimeSlot('12:00-13:00')
    useCartStore.getState().setCep('01001000')
    useCartStore.getState().setDeliveryEstimate(1500, 45)
    useCartStore.getState().setMedusaCartId('cart_abc')

    useCartStore.getState().clearCart()

    const state = useCartStore.getState()
    expect(state.items).toEqual([])
    expect(state.deliveryType).toBe('delivery')
    expect(state.couponCode).toBeUndefined()
    expect(state.selectedAddress).toBeUndefined()
    expect(state.selectedTimeSlot).toBeUndefined()
    expect(state.cep).toBeUndefined()
    expect(state.deliveryFee).toBeUndefined()
    expect(state.estimatedDeliveryMinutes).toBeUndefined()
    expect(state.lastModifiedAt).toBeUndefined()
    expect(state.medusaCartId).toBeUndefined()
  })
})

// ── getTotal ────────────────────────────────────────────────────────────

describe('getTotal', () => {
  it('returns 0 for empty cart', () => {
    expect(useCartStore.getState().getTotal()).toBe(0)
  })

  it('returns price * quantity for single item', () => {
    useCartStore.getState().addItem(createProduct({ price: 8900 }), 2)
    expect(useCartStore.getState().getTotal()).toBe(17800)
  })

  it('sums across multiple items (integer centavos)', () => {
    useCartStore.getState().addItem(createProduct({ id: 'p1', price: 8900 }), 2)
    useCartStore.getState().addItem(createProduct({ id: 'p2', price: 4500 }), 1)
    // 8900*2 + 4500*1 = 22300 centavos = R$223,00
    expect(useCartStore.getState().getTotal()).toBe(22300)
  })

  it('handles large quantities without floating point issues', () => {
    useCartStore.getState().addItem(createProduct({ price: 9999 }), 100)
    // 9999 * 100 = 999900 centavos = R$9.999,00
    expect(useCartStore.getState().getTotal()).toBe(999900)
  })
})

// ── getItemCount ────────────────────────────────────────────────────────

describe('getItemCount', () => {
  it('returns 0 for empty cart', () => {
    expect(useCartStore.getState().getItemCount()).toBe(0)
  })

  it('returns sum of quantities across all items', () => {
    useCartStore.getState().addItem(createProduct({ id: 'p1' }), 3)
    useCartStore.getState().addItem(createProduct({ id: 'p2' }), 2)
    expect(useCartStore.getState().getItemCount()).toBe(5)
  })

  it('reflects quantity updates', () => {
    useCartStore.getState().addItem(createProduct(), 1)
    useCartStore.getState().updateItem('prod_1', { quantity: 10 })
    expect(useCartStore.getState().getItemCount()).toBe(10)
  })
})

// ── getCartType / hasMerchandise / hasFood ──────────────────────────────

describe('getCartType', () => {
  it('returns "empty" for empty cart', () => {
    expect(useCartStore.getState().getCartType()).toBe('empty')
  })

  it('returns "food" for food-only cart', () => {
    useCartStore.getState().addItem(createProduct({ productType: 'food' as ProductDTO['productType'] }), 1)
    expect(useCartStore.getState().getCartType()).toBe('food')
  })

  it('returns "merchandise" for merchandise-only cart', () => {
    useCartStore.getState().addItem(
      createProduct({ id: 'p_merch', productType: 'merchandise' as ProductDTO['productType'] }),
      1,
    )
    expect(useCartStore.getState().getCartType()).toBe('merchandise')
  })

  it('returns "mixed" for food + merchandise', () => {
    useCartStore.getState().addItem(createProduct({ id: 'p1', productType: 'food' as ProductDTO['productType'] }), 1)
    useCartStore.getState().addItem(createProduct({ id: 'p2', productType: 'merchandise' as ProductDTO['productType'] }), 1)
    expect(useCartStore.getState().getCartType()).toBe('mixed')
  })
})

describe('hasMerchandise', () => {
  it('returns false for empty cart', () => {
    expect(useCartStore.getState().hasMerchandise()).toBe(false)
  })

  it('returns true when merchandise present', () => {
    useCartStore.getState().addItem(
      createProduct({ productType: 'merchandise' as ProductDTO['productType'] }),
      1,
    )
    expect(useCartStore.getState().hasMerchandise()).toBe(true)
  })
})

describe('hasFood', () => {
  it('returns false for empty cart', () => {
    expect(useCartStore.getState().hasFood()).toBe(false)
  })

  it('returns true for food items', () => {
    useCartStore.getState().addItem(createProduct({ productType: 'food' as ProductDTO['productType'] }), 1)
    expect(useCartStore.getState().hasFood()).toBe(true)
  })

  it('returns true for frozen items', () => {
    useCartStore.getState().addItem(createProduct({ productType: 'frozen' as ProductDTO['productType'] }), 1)
    expect(useCartStore.getState().hasFood()).toBe(true)
  })
})

// ── Setter actions ──────────────────────────────────────────────────────

describe('setter actions', () => {
  it('setDeliveryType sets delivery type', () => {
    useCartStore.getState().setDeliveryType('pickup')
    expect(useCartStore.getState().deliveryType).toBe('pickup')
  })

  it('setCouponCode sets and clears coupon', () => {
    useCartStore.getState().setCouponCode('PROMO10')
    expect(useCartStore.getState().couponCode).toBe('PROMO10')

    useCartStore.getState().setCouponCode(undefined)
    expect(useCartStore.getState().couponCode).toBeUndefined()
  })

  it('setCep sets CEP', () => {
    useCartStore.getState().setCep('01001000')
    expect(useCartStore.getState().cep).toBe('01001000')
  })

  it('setDeliveryEstimate sets fee and minutes', () => {
    useCartStore.getState().setDeliveryEstimate(1500, 45)
    expect(useCartStore.getState().deliveryFee).toBe(1500)
    expect(useCartStore.getState().estimatedDeliveryMinutes).toBe(45)
  })

  it('setMedusaCartId and clearMedusaCartId manage cart ID', () => {
    useCartStore.getState().setMedusaCartId('cart_xyz')
    expect(useCartStore.getState().medusaCartId).toBe('cart_xyz')

    useCartStore.getState().clearMedusaCartId()
    expect(useCartStore.getState().medusaCartId).toBeUndefined()
  })
})
