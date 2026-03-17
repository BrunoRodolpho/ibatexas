/**
 * UI store tests — pure logic only, no DOM.
 *
 * Tests zustand store actions via getState()/setState().
 * Uses vi.useFakeTimers() for toast auto-removal timing.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useUIStore, type UpsellSuggestion } from '../ui.store'

// ── Helpers ──────────────────────────────────────────────────────────────

let uuidCounter = 0

function resetStore() {
  useUIStore.setState({
    isMobileNavOpen: false,
    isChatOpen: false,
    isCartDrawerOpen: false,
    selectedFilters: { tags: [] },
    toasts: [],
    upsellTriggerCategory: null,
    upsellProduct: null,
  })
}

function createUpsellProduct(overrides: Partial<UpsellSuggestion> = {}): UpsellSuggestion {
  return {
    productId: 'prod_upsell_1',
    title: 'Farofa de Bacon',
    price: 2500,
    imageUrl: 'https://img.test/farofa.jpg',
    ...overrides,
  }
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  uuidCounter = 0
  vi.stubGlobal('crypto', {
    randomUUID: () => `fake-uuid-${++uuidCounter}`,
  })
  resetStore()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ── toggleMobileNav ──────────────────────────────────────────────────────

describe('toggleMobileNav', () => {
  it('toggles isMobileNavOpen from false to true', () => {
    useUIStore.getState().toggleMobileNav()
    expect(useUIStore.getState().isMobileNavOpen).toBe(true)
  })

  it('toggles isMobileNavOpen from true to false', () => {
    useUIStore.setState({ isMobileNavOpen: true })
    useUIStore.getState().toggleMobileNav()
    expect(useUIStore.getState().isMobileNavOpen).toBe(false)
  })
})

// ── toggleChat ───────────────────────────────────────────────────────────

describe('toggleChat', () => {
  it('toggles isChatOpen from false to true', () => {
    useUIStore.getState().toggleChat()
    expect(useUIStore.getState().isChatOpen).toBe(true)
  })

  it('toggles isChatOpen from true to false', () => {
    useUIStore.setState({ isChatOpen: true })
    useUIStore.getState().toggleChat()
    expect(useUIStore.getState().isChatOpen).toBe(false)
  })
})

// ── setMobileNav / setChat ───────────────────────────────────────────────

describe('setMobileNav', () => {
  it('sets isMobileNavOpen to true', () => {
    useUIStore.getState().setMobileNav(true)
    expect(useUIStore.getState().isMobileNavOpen).toBe(true)
  })

  it('sets isMobileNavOpen to false', () => {
    useUIStore.setState({ isMobileNavOpen: true })
    useUIStore.getState().setMobileNav(false)
    expect(useUIStore.getState().isMobileNavOpen).toBe(false)
  })
})

describe('setChat', () => {
  it('sets isChatOpen to true', () => {
    useUIStore.getState().setChat(true)
    expect(useUIStore.getState().isChatOpen).toBe(true)
  })

  it('sets isChatOpen to false', () => {
    useUIStore.setState({ isChatOpen: true })
    useUIStore.getState().setChat(false)
    expect(useUIStore.getState().isChatOpen).toBe(false)
  })
})

// ── Cart drawer ──────────────────────────────────────────────────────────

describe('cart drawer', () => {
  it('openCartDrawer sets isCartDrawerOpen to true', () => {
    useUIStore.getState().openCartDrawer()
    expect(useUIStore.getState().isCartDrawerOpen).toBe(true)
  })

  it('closeCartDrawer sets isCartDrawerOpen to false', () => {
    useUIStore.setState({ isCartDrawerOpen: true })
    useUIStore.getState().closeCartDrawer()
    expect(useUIStore.getState().isCartDrawerOpen).toBe(false)
  })

  it('toggleCartDrawer toggles from false to true', () => {
    useUIStore.getState().toggleCartDrawer()
    expect(useUIStore.getState().isCartDrawerOpen).toBe(true)
  })

  it('toggleCartDrawer toggles from true to false', () => {
    useUIStore.setState({ isCartDrawerOpen: true })
    useUIStore.getState().toggleCartDrawer()
    expect(useUIStore.getState().isCartDrawerOpen).toBe(false)
  })
})

// ── Filters ──────────────────────────────────────────────────────────────

describe('setFilters', () => {
  it('merges partial filters into selectedFilters', () => {
    useUIStore.getState().setFilters({ tags: ['defumados', 'premium'] })
    expect(useUIStore.getState().selectedFilters.tags).toEqual(['defumados', 'premium'])
  })

  it('preserves existing filter fields when merging new ones', () => {
    useUIStore.getState().setFilters({ tags: ['defumados'] })
    useUIStore.getState().setFilters({ category: 'carnes' })

    const filters = useUIStore.getState().selectedFilters
    expect(filters.tags).toEqual(['defumados'])
    expect(filters.category).toBe('carnes')
  })

  it('overwrites tags when setting new tags', () => {
    useUIStore.getState().setFilters({ tags: ['a', 'b'] })
    useUIStore.getState().setFilters({ tags: ['c'] })
    expect(useUIStore.getState().selectedFilters.tags).toEqual(['c'])
  })
})

describe('resetFilters', () => {
  it('resets selectedFilters to empty tags', () => {
    useUIStore.getState().setFilters({ tags: ['premium'], category: 'carnes', sort: 'price' })
    useUIStore.getState().resetFilters()

    const filters = useUIStore.getState().selectedFilters
    expect(filters.tags).toEqual([])
    expect(filters.category).toBeUndefined()
    expect(filters.sort).toBeUndefined()
  })
})

// ── Toasts ───────────────────────────────────────────────────────────────

describe('addToast', () => {
  it('adds a toast to the toasts array', () => {
    useUIStore.getState().addToast('Item adicionado ao carrinho', 'cart')
    const { toasts } = useUIStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe('Item adicionado ao carrinho')
    expect(toasts[0].type).toBe('cart')
  })

  it('generates a toast ID starting with "toast-"', () => {
    useUIStore.getState().addToast('Sucesso', 'success')
    const { toasts } = useUIStore.getState()
    expect(toasts[0].id).toMatch(/^toast-/)
  })

  it('auto-removes toast after default duration (5000ms)', () => {
    useUIStore.getState().addToast('Temporario', 'info')
    expect(useUIStore.getState().toasts).toHaveLength(1)

    vi.advanceTimersByTime(5000)
    expect(useUIStore.getState().toasts).toHaveLength(0)
  })

  it('auto-removes toast after custom duration', () => {
    useUIStore.getState().addToast('Rapido', 'warning', 2000)
    expect(useUIStore.getState().toasts).toHaveLength(1)

    vi.advanceTimersByTime(1999)
    expect(useUIStore.getState().toasts).toHaveLength(1)

    vi.advanceTimersByTime(1)
    expect(useUIStore.getState().toasts).toHaveLength(0)
  })

  it('does not auto-remove when duration is 0', () => {
    useUIStore.getState().addToast('Permanente', 'error', 0)
    vi.advanceTimersByTime(60000)
    expect(useUIStore.getState().toasts).toHaveLength(1)
  })

  it('adds multiple toasts without interfering', () => {
    useUIStore.getState().addToast('Primeiro', 'success')
    useUIStore.getState().addToast('Segundo', 'error')
    expect(useUIStore.getState().toasts).toHaveLength(2)
  })
})

describe('removeToast', () => {
  it('removes a toast by id', () => {
    useUIStore.getState().addToast('A ser removido', 'info', 0)
    const id = useUIStore.getState().toasts[0].id
    useUIStore.getState().removeToast(id)
    expect(useUIStore.getState().toasts).toHaveLength(0)
  })

  it('does not affect other toasts when removing one', () => {
    useUIStore.getState().addToast('Primeiro', 'success', 0)
    useUIStore.getState().addToast('Segundo', 'error', 0)
    const firstId = useUIStore.getState().toasts[0].id

    useUIStore.getState().removeToast(firstId)
    const { toasts } = useUIStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe('Segundo')
  })

  it('is a no-op when id does not exist', () => {
    useUIStore.getState().addToast('Existente', 'info', 0)
    useUIStore.getState().removeToast('nonexistent-id')
    expect(useUIStore.getState().toasts).toHaveLength(1)
  })
})

// ── Upsell ───────────────────────────────────────────────────────────────

describe('triggerUpsell', () => {
  it('sets upsellTriggerCategory and clears upsellProduct', () => {
    useUIStore.setState({ upsellProduct: createUpsellProduct() })
    useUIStore.getState().triggerUpsell('acompanhamentos')

    const state = useUIStore.getState()
    expect(state.upsellTriggerCategory).toBe('acompanhamentos')
    expect(state.upsellProduct).toBeNull()
  })
})

describe('setUpsellProduct', () => {
  it('sets the upsell product suggestion', () => {
    const product = createUpsellProduct()
    useUIStore.getState().setUpsellProduct(product)

    const state = useUIStore.getState()
    expect(state.upsellProduct).toEqual(product)
    expect(state.upsellProduct!.price).toBe(2500)
  })
})

describe('dismissUpsell', () => {
  it('clears both upsellTriggerCategory and upsellProduct', () => {
    useUIStore.setState({
      upsellTriggerCategory: 'sobremesas',
      upsellProduct: createUpsellProduct(),
    })
    useUIStore.getState().dismissUpsell()

    const state = useUIStore.getState()
    expect(state.upsellTriggerCategory).toBeNull()
    expect(state.upsellProduct).toBeNull()
  })

  it('is a no-op on already cleared upsell state', () => {
    useUIStore.getState().dismissUpsell()
    const state = useUIStore.getState()
    expect(state.upsellTriggerCategory).toBeNull()
    expect(state.upsellProduct).toBeNull()
  })
})
