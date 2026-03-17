/**
 * Wishlist store tests — pure logic only, no DOM.
 *
 * Tests zustand store actions via getState()/setState().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWishlistStore } from '../wishlist.store'

// ── Setup ───────────────────────────────────────────────────────────────

function resetStore() {
  useWishlistStore.setState({ items: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})

// ── toggle ──────────────────────────────────────────────────────────────

describe('toggle', () => {
  it('adds a product to empty wishlist', () => {
    useWishlistStore.getState().toggle('prod_1')
    expect(useWishlistStore.getState().items).toEqual(['prod_1'])
  })

  it('removes a product that is already in wishlist', () => {
    useWishlistStore.setState({ items: ['prod_1'] })
    useWishlistStore.getState().toggle('prod_1')
    expect(useWishlistStore.getState().items).toEqual([])
  })

  it('adds a second product without removing the first', () => {
    useWishlistStore.getState().toggle('prod_1')
    useWishlistStore.getState().toggle('prod_2')
    expect(useWishlistStore.getState().items).toEqual(['prod_1', 'prod_2'])
  })

  it('toggling twice returns to empty state', () => {
    useWishlistStore.getState().toggle('prod_1')
    useWishlistStore.getState().toggle('prod_1')
    expect(useWishlistStore.getState().items).toEqual([])
  })

  it('toggling three times leaves product in wishlist', () => {
    useWishlistStore.getState().toggle('prod_1')
    useWishlistStore.getState().toggle('prod_1')
    useWishlistStore.getState().toggle('prod_1')
    expect(useWishlistStore.getState().items).toEqual(['prod_1'])
  })

  it('only removes the toggled product, not others', () => {
    useWishlistStore.setState({ items: ['prod_1', 'prod_2', 'prod_3'] })
    useWishlistStore.getState().toggle('prod_2')
    expect(useWishlistStore.getState().items).toEqual(['prod_1', 'prod_3'])
  })

  it('handles empty string product ID', () => {
    useWishlistStore.getState().toggle('')
    expect(useWishlistStore.getState().items).toEqual([''])
  })
})

// ── isFavorite ──────────────────────────────────────────────────────────

describe('isFavorite', () => {
  it('returns false for empty wishlist', () => {
    expect(useWishlistStore.getState().isFavorite('prod_1')).toBe(false)
  })

  it('returns true for a product in the wishlist', () => {
    useWishlistStore.setState({ items: ['prod_1', 'prod_2'] })
    expect(useWishlistStore.getState().isFavorite('prod_1')).toBe(true)
    expect(useWishlistStore.getState().isFavorite('prod_2')).toBe(true)
  })

  it('returns false for a product not in the wishlist', () => {
    useWishlistStore.setState({ items: ['prod_1'] })
    expect(useWishlistStore.getState().isFavorite('prod_99')).toBe(false)
  })

  it('reflects toggle operations correctly', () => {
    useWishlistStore.getState().toggle('prod_1')
    expect(useWishlistStore.getState().isFavorite('prod_1')).toBe(true)

    useWishlistStore.getState().toggle('prod_1')
    expect(useWishlistStore.getState().isFavorite('prod_1')).toBe(false)
  })
})

// ── clear ───────────────────────────────────────────────────────────────

describe('clear', () => {
  it('empties the entire wishlist', () => {
    useWishlistStore.setState({ items: ['prod_1', 'prod_2', 'prod_3'] })
    useWishlistStore.getState().clear()
    expect(useWishlistStore.getState().items).toEqual([])
  })

  it('is a no-op on empty wishlist', () => {
    useWishlistStore.getState().clear()
    expect(useWishlistStore.getState().items).toEqual([])
  })

  it('isFavorite returns false for all items after clear', () => {
    useWishlistStore.setState({ items: ['prod_1', 'prod_2'] })
    useWishlistStore.getState().clear()
    expect(useWishlistStore.getState().isFavorite('prod_1')).toBe(false)
    expect(useWishlistStore.getState().isFavorite('prod_2')).toBe(false)
  })
})

// ── Ordering ────────────────────────────────────────────────────────────

describe('ordering', () => {
  it('preserves insertion order', () => {
    useWishlistStore.getState().toggle('c')
    useWishlistStore.getState().toggle('a')
    useWishlistStore.getState().toggle('b')
    expect(useWishlistStore.getState().items).toEqual(['c', 'a', 'b'])
  })

  it('re-adding a removed item places it at the end', () => {
    useWishlistStore.setState({ items: ['prod_1', 'prod_2', 'prod_3'] })
    useWishlistStore.getState().toggle('prod_1') // remove
    useWishlistStore.getState().toggle('prod_1') // re-add at end
    expect(useWishlistStore.getState().items).toEqual(['prod_2', 'prod_3', 'prod_1'])
  })
})
