/**
 * Medusa → Domain mappers for the Admin context.
 *
 * Isolates the raw Medusa API shape from the rest of the app.
 * If the Medusa response changes, only this file needs updating.
 */
import type { OrderSummary } from '@ibatexas/types'

// ── Raw Medusa order shape (what the API actually returns) ───────────────

export interface MedusaOrderRaw {
  id: string
  display_id?: number
  email?: string
  customer?: {
    first_name?: string
    last_name?: string
  }
  items?: unknown[]
  total?: number
  status?: string
  payment_status?: string
  fulfillment_status?: string
  created_at?: string
}

// ── Mapper ───────────────────────────────────────────────────────────────

function buildCustomerName(customer?: { first_name?: string; last_name?: string }): string | undefined {
  if (!customer) return undefined
  const full = `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim()
  return full || undefined
}

/**
 * Map a raw Medusa order object into our domain OrderSummary.
 * Pure function — no side effects, fully testable.
 */
export function mapMedusaOrderToSummary(o: MedusaOrderRaw): OrderSummary {
  return {
    id: o.id,
    displayId: o.display_id ?? 0,
    customerEmail: o.email ?? '—',
    customerName: buildCustomerName(o.customer),
    itemCount: Array.isArray(o.items) ? o.items.length : 0,
    total: o.total ?? 0,
    status: o.status ?? '—',
    paymentStatus: o.payment_status ?? '—',
    fulfillmentStatus: o.fulfillment_status ?? '—',
    createdAt: o.created_at ?? '',
  }
}
