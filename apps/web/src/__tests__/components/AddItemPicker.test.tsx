// AddItemPicker (CUS-039) — post-order add-item picker.
//
// Strategy mirrors OrderActions.cancel.test.tsx / CheckoutContent.test.tsx:
// node vitest env, react hooks mocked (useState returns [overridable-initial,
// captured setter] by call order), the real jsx-runtime builds a plain element
// tree we flatten + invoke handlers against. `useProducts` is mocked so we drive
// the catalog results without a fetch.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'

const h = vi.hoisted(() => ({
  onAdd: vi.fn(),
  onBack: vi.fn(),
  products: { data: null as { items: ProductDTO[] } | null, loading: false },
  overrides: {} as Record<number, unknown>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  idx: { v: 0 },
}))

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = h.idx.v++
    const setter = vi.fn()
    h.setters[i] = setter
    return [i in h.overrides ? h.overrides[i] : init, setter]
  },
  default: {},
}))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@ibatexas/ui/atoms', () => ({ Button: 'Button', TextField: 'TextField' }))
vi.mock('@/lib/format', () => ({ formatBRL: (c: number) => `R$ ${c}` }))
vi.mock('@/domains/product', () => ({ useProducts: () => h.products }))

import { AddItemPicker } from '../../components/molecules/AddItemPicker'

// useState call order in AddItemPicker: 0 query, 1 selectedProductId, 2 selectedVariantId, 3 quantity
const Q = { query: 0, productId: 1, variantId: 2, quantity: 3 } as const

function variant(over: Partial<ProductVariant> = {}): ProductVariant {
  return { id: 'v1', title: 'Padrão', sku: null, price: 5000, ...over }
}
function product(over: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: 'p1', title: 'Costela', description: null, price: 8900, imageUrl: null, images: [],
    tags: [], availabilityWindow: 'sempre' as ProductDTO['availabilityWindow'], allergens: [],
    variants: [variant()], productType: 'food' as ProductDTO['productType'],
    createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
  }
}

// Flatten the returned element tree into a list of nodes with props. Handles
// arrays at any level (children arrays AND `.map()` result arrays).
function flatten(node: unknown, acc: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const c of node) flatten(c, acc)
    return acc
  }
  if (!node || typeof node !== 'object') return acc
  const props = (node as { props?: Record<string, unknown> }).props
  if (props) {
    acc.push(props)
    flatten(props.children, acc)
  }
  return acc
}

function render(opts: { overrides?: Record<number, unknown>; products?: ProductDTO[]; loading?: boolean; isSubmitting?: boolean } = {}) {
  h.setters = []
  h.idx.v = 0
  h.overrides = opts.overrides ?? {}
  h.products = { data: opts.products ? { items: opts.products } : null, loading: opts.loading ?? false }
  const tree = AddItemPicker({ onAdd: h.onAdd, onBack: h.onBack, isSubmitting: opts.isSubmitting ?? false })
  return flatten(tree)
}

function onClicks(nodes: Array<Record<string, unknown>>): Array<() => unknown> {
  return nodes.filter((p) => typeof p.onClick === 'function').map((p) => p.onClick as () => unknown)
}

beforeEach(() => vi.clearAllMocks())

describe('AddItemPicker (CUS-039)', () => {
  it('renders the loading state while the catalog fetch is in flight', () => {
    const nodes = render({ loading: true })
    const texts = nodes.map((p) => p.children)
    expect(texts).toContain('amend_add_loading')
  })

  it('renders the empty state when no products match', () => {
    const nodes = render({ products: [], loading: false })
    const texts = nodes.map((p) => p.children)
    expect(texts).toContain('amend_add_empty')
  })

  it('search input change drives setQuery', () => {
    const nodes = render({ products: [product()] })
    const field = nodes.find((p) => typeof p.onChange === 'function')
    ;(field!.onChange as (e: unknown) => void)({ target: { value: 'costela' } })
    expect(h.setters[Q.query]).toHaveBeenCalledWith('costela')
  })

  it('selecting a product sets product id + defaults the variant', () => {
    const nodes = render({ products: [product({ id: 'p1', variants: [variant({ id: 'vA' })] })] })
    // Fire every button onClick; the product-row click drives the two setters.
    onClicks(nodes).forEach((fn) => fn())
    expect(h.setters[Q.productId]).toHaveBeenCalledWith('p1')
    expect(h.setters[Q.variantId]).toHaveBeenCalledWith('vA')
  })

  it('shows variant chips only when the selected product has >1 variant', () => {
    const p = product({ id: 'p1', variants: [variant({ id: 'vA', title: 'P' }), variant({ id: 'vB', title: 'G' })] })
    const nodes = render({ products: [p], overrides: { [Q.productId]: 'p1' } })
    const texts = nodes.map((n) => n.children)
    expect(texts).toContain('amend_add_variant_label')
    // A variant chip click sets the chosen variant id.
    onClicks(nodes).forEach((fn) => fn())
    expect(h.setters[Q.variantId]).toHaveBeenCalledWith('vB')
  })

  it('quantity steppers drive setQuantity with bounded updaters', () => {
    const nodes = render({ products: [product({ id: 'p1' })], overrides: { [Q.productId]: 'p1', [Q.quantity]: 3 } })
    onClicks(nodes).forEach((fn) => fn())
    const qtyCalls = h.setters[Q.quantity].mock.calls.map((c) => c[0] as (q: number) => number)
    // Decrement then increment updaters applied to the current qty.
    expect(qtyCalls.some((fn) => typeof fn === 'function' && fn(3) === 2)).toBe(true)
    expect(qtyCalls.some((fn) => typeof fn === 'function' && fn(3) === 4)).toBe(true)
  })

  it('confirm button emits onAdd with the resolved variant + quantity', () => {
    const p = product({ id: 'p1', variants: [variant({ id: 'vA' })] })
    const nodes = render({ products: [p], overrides: { [Q.productId]: 'p1', [Q.variantId]: 'vA', [Q.quantity]: 2 } })
    onClicks(nodes).forEach((fn) => fn())
    expect(h.onAdd).toHaveBeenCalledWith('vA', 2)
  })

  it('back button invokes onBack', () => {
    const nodes = render({ products: [product()] })
    onClicks(nodes).forEach((fn) => fn())
    expect(h.onBack).toHaveBeenCalled()
  })

  it('disables the confirm button while a submit is in flight', () => {
    const p = product({ id: 'p1', variants: [variant({ id: 'vA' })] })
    const nodes = render({ products: [p], overrides: { [Q.productId]: 'p1', [Q.variantId]: 'vA' }, isSubmitting: true })
    // The confirm button carries isLoading + disabled while the add is in flight.
    const confirm = nodes.find((n) => n.isLoading === true)
    expect(confirm).toBeDefined()
    expect(confirm!.disabled).toBe(true)
  })
})
