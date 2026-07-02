/**
 * Product reviews (CUS-049 web view). fetchReviewableOrders reduces the
 * authenticated /api/customer/orders projection to delivered orders + their
 * reviewable products; submitOrderReview POSTs the governed review. The pure
 * predicates (canReviewOrder / isValidRating) gate the UI so the customer never
 * hits a server 403 / 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ apiFetch: mockApiFetch }))

import {
  fetchReviewableOrders,
  submitOrderReview,
  canReviewOrder,
  isValidRating,
  MIN_RATING,
  MAX_RATING,
} from '../reviews'

describe('reviews — canReviewOrder (CUS-049)', () => {
  it('allows only delivered orders', () => {
    expect(canReviewOrder('delivered')).toBe(true)
  })
  it('rejects every non-delivered state', () => {
    for (const s of ['pending', 'confirmed', 'preparing', 'ready', 'in_delivery', 'canceled', 'completed', null, undefined]) {
      expect(canReviewOrder(s)).toBe(false)
    }
  })
})

describe('reviews — isValidRating (CUS-049)', () => {
  it('accepts integers within [1,5]', () => {
    for (let r = MIN_RATING; r <= MAX_RATING; r++) expect(isValidRating(r)).toBe(true)
  })
  it('rejects out-of-range or non-integer ratings', () => {
    for (const r of [0, 6, -1, 2.5, Number.NaN]) expect(isValidRating(r)).toBe(false)
  })
})

describe('reviews — fetchReviewableOrders (CUS-049)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps only delivered orders and their productId-bearing items', async () => {
    mockApiFetch.mockResolvedValue({
      orders: [
        {
          id: 'o1',
          display_id: 11,
          fulfillment_status: 'delivered',
          created_at: '2026-06-01',
          items: [
            { productId: 'p1', title: 'Costela' },
            { title: 'sem productId — descartado' },
          ],
        },
        { id: 'o2', fulfillment_status: 'preparing', items: [{ productId: 'p9', title: 'x' }] },
      ],
    })
    const out = await fetchReviewableOrders()
    expect(out).toEqual([
      { orderId: 'o1', displayId: 11, createdAt: '2026-06-01', items: [{ productId: 'p1', title: 'Costela' }] },
    ])
    expect(mockApiFetch).toHaveBeenCalledWith('/api/customer/orders', { credentials: 'include' })
  })

  it('drops delivered orders that have no reviewable items', async () => {
    mockApiFetch.mockResolvedValue({
      orders: [{ id: 'o1', fulfillment_status: 'delivered', items: [{ title: 'no id' }] }],
    })
    expect(await fetchReviewableOrders()).toEqual([])
  })

  it('returns [] on a read error', async () => {
    mockApiFetch.mockRejectedValue(new Error('500'))
    expect(await fetchReviewableOrders()).toEqual([])
  })
})

describe('reviews — submitOrderReview (CUS-049)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POSTs the review, trimming and omitting an empty comment', async () => {
    mockApiFetch.mockResolvedValue({ success: true, message: 'ok' })
    await submitOrderReview({ orderId: 'o1', productId: 'p1', rating: 5, comment: '   ' })
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/reviews',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ orderId: 'o1', productId: 'p1', rating: 5 }),
      }),
    )
  })

  it('includes a non-empty comment (trimmed)', async () => {
    mockApiFetch.mockResolvedValue({ success: true, message: 'ok' })
    await submitOrderReview({ orderId: 'o1', productId: 'p1', rating: 4, comment: '  bom  ' })
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/reviews',
      expect.objectContaining({
        body: JSON.stringify({ orderId: 'o1', productId: 'p1', rating: 4, comment: 'bom' }),
      }),
    )
  })
})
