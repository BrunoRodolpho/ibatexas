/**
 * Product reviews (CUS-049, web view).
 *
 * A customer may review a product from one of their own DELIVERED orders. The
 * write is governed server-side (POST /api/me/reviews adjudicates an
 * `order.review.submit` envelope and owner-scopes the order); this module only
 * carries the fetch + the pure eligibility predicate the UI gates on.
 */

import { apiFetch } from '@/lib/api'

export interface SubmitReviewInput {
  readonly orderId: string
  readonly productId: string
  readonly rating: number
  readonly comment?: string
}

/** Rating bounds mirror the server schema (integer 1–5). */
export const MIN_RATING = 1
export const MAX_RATING = 5

/**
 * True only for a delivered order — matches the server's "após a entrega" gate.
 * The UI hides the review affordance for any other fulfillment state so the
 * customer never hits a server 403.
 */
export function canReviewOrder(fulfillmentStatus: string | null | undefined): boolean {
  return fulfillmentStatus === 'delivered'
}

/** True when the rating is an integer within [MIN_RATING, MAX_RATING]. */
export function isValidRating(rating: number): boolean {
  return Number.isInteger(rating) && rating >= MIN_RATING && rating <= MAX_RATING
}

export interface ReviewableItem {
  readonly productId: string
  readonly title: string
}

export interface ReviewableOrder {
  readonly orderId: string
  readonly displayId: number
  readonly createdAt: string
  readonly items: ReviewableItem[]
}

/** Raw item shape from the projection itemsJson returned by /api/customer/orders. */
interface RawOrderItem {
  readonly productId?: string
  readonly title?: string
}

interface RawCustomerOrder {
  readonly id: string
  readonly display_id?: number
  readonly status?: string
  readonly fulfillment_status?: string
  readonly created_at?: string
  readonly items?: RawOrderItem[]
}

/**
 * The customer's delivered orders, reduced to the products they can review.
 * Sourced from the authenticated, owner-scoped /api/customer/orders projection
 * (its itemsJson carries productId + title). Non-delivered orders and items
 * without a productId are dropped so the UI only ever offers a valid target.
 * Returns [] on any read error (the page renders an empty state).
 */
export async function fetchReviewableOrders(): Promise<ReviewableOrder[]> {
  try {
    const data = await apiFetch<{ orders?: RawCustomerOrder[] }>('/api/customer/orders', {
      credentials: 'include',
    })
    const orders = data.orders ?? []
    return orders
      .filter((o) => canReviewOrder(o.fulfillment_status ?? o.status))
      .map((o) => ({
        orderId: o.id,
        displayId: o.display_id ?? 0,
        createdAt: o.created_at ?? '',
        items: (o.items ?? [])
          .filter((it): it is RawOrderItem & { productId: string } => Boolean(it.productId))
          .map((it) => ({ productId: it.productId, title: it.title ?? 'Produto' })),
      }))
      .filter((o) => o.items.length > 0)
  } catch {
    return []
  }
}

/**
 * Submit a review through the governed POST /api/me/reviews. Throws on a
 * non-2xx (the caller renders the failure). Omits an empty comment.
 */
export async function submitOrderReview(input: SubmitReviewInput): Promise<{ success: boolean; message: string }> {
  const comment = input.comment?.trim()
  return apiFetch<{ success: boolean; message: string }>('/api/me/reviews', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({
      orderId: input.orderId,
      productId: input.productId,
      rating: input.rating,
      ...(comment ? { comment } : {}),
    }),
  })
}
