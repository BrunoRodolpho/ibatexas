import { describe, it, expect } from 'vitest'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'
import {
  resolveCartItemId,
  buildCartItem,
  migrateCartState,
  getCartType,
  hasMerchandise,
  hasFood,
  hasKitchenOnlyFood,
  getKitchenItems,
  getAvailableItems,
} from '../cart.logic'

// ── Typed test fixtures ──────────────────────────────────────────────────

/** Minimal ProductDTO fixture — only the fields buildCartItem reads. */
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
    title: 'Default',
    sku: null,
    price: 8900,
    ...overrides,
  }
}

// ── resolveCartItemId ───────────────────────────────────────────────────

describe('resolveCartItemId', () => {
  it('returns productId:variantId when variant exists', () => {
    expect(resolveCartItemId('prod_1', 'var_a')).toBe('prod_1:var_a')
  })

  it('returns productId alone when no variant', () => {
    expect(resolveCartItemId('prod_1')).toBe('prod_1')
    expect(resolveCartItemId('prod_1', undefined)).toBe('prod_1')
  })
})

// ── buildCartItem ───────────────────────────────────────────────────────

describe('buildCartItem', () => {
  const baseProduct = createProduct()

  it('builds a cart item from product without variant', () => {
    const item = buildCartItem(baseProduct, undefined, 2, 'Sem molho')
    expect(item).toEqual({
      id: 'prod_1',
      productId: 'prod_1',
      title: 'Costela Defumada',
      price: 8900,
      imageUrl: 'https://img.test/costela.jpg',
      quantity: 2,
      specialInstructions: 'Sem molho',
      productType: 'food',
      variantId: undefined,
      variantTitle: undefined,
    })
  })

  it('uses variant price and id when variant provided', () => {
    const variant = createVariant({ id: 'var_lg', title: 'Grande', price: 12900 })
    const item = buildCartItem(baseProduct, variant, 1)
    expect(item.id).toBe('prod_1:var_lg')
    expect(item.price).toBe(12900)
    expect(item.variantId).toBe('var_lg')
    expect(item.variantTitle).toBe('Grande')
  })

  it('falls back to product price when variant has no price', () => {
    // Simulate a persisted variant that lost its price (e.g. migration gap).
    // Runtime data can violate TS types, so we cast through unknown.
    const variant = { id: 'var_x', title: 'Default', sku: null, price: undefined } as unknown as ProductVariant
    const item = buildCartItem(baseProduct, variant, 1)
    expect(item.price).toBe(8900)
  })
})

// ── migrateCartState ────────────────────────────────────────────────────

interface MigratedItem {
  id?: string
  productId?: string
  productType?: string
  variantId?: string
}

describe('migrateCartState', () => {
  it('returns state unchanged when items is not an array', () => {
    const state = { version: 2 }
    expect(migrateCartState(state, 2)).toEqual(state)
  })

  it('migrates v2 → v3: defaults productType to food', () => {
    const state = {
      items: [
        { id: 'p1', title: 'Costela', price: 8900 },
        { id: 'p2', title: 'Camiseta', price: 4900, productType: 'merchandise' },
      ],
    }
    const result = migrateCartState(state, 2)
    const items = result.items as MigratedItem[]
    expect(items[0].productType).toBe('food')
    expect(items[1].productType).toBe('merchandise')
  })

  it('migrates v3 → v4: adds productId and variantId', () => {
    const state = {
      items: [
        { id: 'p1', title: 'Costela', price: 8900, productType: 'food' },
      ],
    }
    const result = migrateCartState(state, 3)
    const items = result.items as MigratedItem[]
    expect(items[0].productId).toBe('p1')
    expect(items[0].variantId).toBeUndefined()
  })

  it('runs both migrations when version is 1', () => {
    const state = {
      items: [{ id: 'p1', title: 'Costela', price: 8900 }],
    }
    const result = migrateCartState(state, 1)
    const items = result.items as MigratedItem[]
    expect(items[0].productType).toBe('food')
    expect(items[0].productId).toBe('p1')
  })

  it('skips all migrations when already at latest version', () => {
    const state = {
      items: [{ id: 'p1', productId: 'p1', productType: 'food', variantId: 'v1' }],
    }
    const result = migrateCartState(state, 4)
    expect(result.items).toEqual(state.items)
  })

  it('handles null persistedState gracefully', () => {
    const result = migrateCartState(null, 1)
    expect(result).toEqual({})
  })
})

// ── getCartType / hasMerchandise / hasFood ────────────────────────────

describe('getCartType', () => {
  it('returns "food" for food-only items', () => {
    expect(getCartType([{ productType: 'food' }, { productType: 'frozen' }])).toBe('food')
  })

  it('returns "merchandise" for merchandise-only items', () => {
    expect(getCartType([{ productType: 'merchandise' }])).toBe('merchandise')
  })

  it('returns "mixed" for food + merchandise', () => {
    expect(getCartType([{ productType: 'food' }, { productType: 'merchandise' }])).toBe('mixed')
  })

  it('returns "empty" for empty cart', () => {
    expect(getCartType([])).toBe('empty')
  })
})

describe('hasMerchandise', () => {
  it('returns true when merchandise present', () => {
    expect(hasMerchandise([{ productType: 'merchandise' }])).toBe(true)
  })

  it('returns false when no merchandise', () => {
    expect(hasMerchandise([{ productType: 'food' }])).toBe(false)
  })
})

describe('hasFood', () => {
  it('returns true for food items', () => {
    expect(hasFood([{ productType: 'food' }])).toBe(true)
  })

  it('returns true for frozen items', () => {
    expect(hasFood([{ productType: 'frozen' }])).toBe(true)
  })

  it('returns false for merchandise only', () => {
    expect(hasFood([{ productType: 'merchandise' }])).toBe(false)
  })
})

// ── hasKitchenOnlyFood / getKitchenItems / getAvailableItems ────────

describe('hasKitchenOnlyFood', () => {
  it('returns true when food items present', () => {
    expect(hasKitchenOnlyFood([{ productType: 'food' }])).toBe(true)
  })

  it('returns false for frozen-only cart', () => {
    expect(hasKitchenOnlyFood([{ productType: 'frozen' }])).toBe(false)
  })

  it('returns false for merchandise-only cart', () => {
    expect(hasKitchenOnlyFood([{ productType: 'merchandise' }])).toBe(false)
  })

  it('returns true for mixed cart with food', () => {
    expect(hasKitchenOnlyFood([
      { productType: 'food' },
      { productType: 'merchandise' },
      { productType: 'frozen' },
    ])).toBe(true)
  })

  it('returns false for empty cart', () => {
    expect(hasKitchenOnlyFood([])).toBe(false)
  })
})

describe('getKitchenItems', () => {
  it('returns only food items', () => {
    const items = [
      { productType: 'food' as const, id: '1' },
      { productType: 'frozen' as const, id: '2' },
      { productType: 'merchandise' as const, id: '3' },
      { productType: 'food' as const, id: '4' },
    ]
    const result = getKitchenItems(items)
    expect(result).toHaveLength(2)
    expect(result.map((i) => i.id)).toEqual(['1', '4'])
  })

  it('returns empty array when no food items', () => {
    expect(getKitchenItems([{ productType: 'frozen' as const, id: '1' }])).toEqual([])
  })
})

describe('getAvailableItems', () => {
  it('returns frozen + merchandise items', () => {
    const items = [
      { productType: 'food' as const, id: '1' },
      { productType: 'frozen' as const, id: '2' },
      { productType: 'merchandise' as const, id: '3' },
    ]
    const result = getAvailableItems(items)
    expect(result).toHaveLength(2)
    expect(result.map((i) => i.id)).toEqual(['2', '3'])
  })

  it('returns empty array when only food items', () => {
    expect(getAvailableItems([{ productType: 'food' as const, id: '1' }])).toEqual([])
  })
})
