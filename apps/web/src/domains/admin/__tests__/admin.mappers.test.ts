import { describe, it, expect } from 'vitest'
import { mapMedusaOrderToSummary, type MedusaOrderRaw } from '../admin.mappers'

describe('mapMedusaOrderToSummary', () => {
  const fullOrder: MedusaOrderRaw = {
    id: 'order_123',
    display_id: 42,
    email: 'cliente@ibatexas.com',
    customer: { first_name: 'João', last_name: 'Silva' },
    items: [{}, {}, {}],
    total: 25800,
    status: 'completed',
    payment_status: 'captured',
    fulfillment_status: 'shipped',
    created_at: '2026-03-01T12:00:00Z',
  }

  it('maps a full Medusa order correctly', () => {
    const summary = mapMedusaOrderToSummary(fullOrder)
    expect(summary).toEqual({
      id: 'order_123',
      displayId: 42,
      customerEmail: 'cliente@ibatexas.com',
      customerName: 'João Silva',
      itemCount: 3,
      total: 25800,
      status: 'completed',
      paymentStatus: 'captured',
      fulfillmentStatus: 'shipped',
      createdAt: '2026-03-01T12:00:00Z',
    })
  })

  it('handles missing optional fields with safe defaults', () => {
    const minimal: MedusaOrderRaw = { id: 'order_min' }
    const summary = mapMedusaOrderToSummary(minimal)
    expect(summary.displayId).toBe(0)
    expect(summary.customerEmail).toBe('—')
    expect(summary.customerName).toBeUndefined()
    expect(summary.itemCount).toBe(0)
    expect(summary.total).toBe(0)
    expect(summary.status).toBe('—')
    expect(summary.paymentStatus).toBe('—')
    expect(summary.fulfillmentStatus).toBe('—')
    expect(summary.createdAt).toBe('')
  })

  it('builds customerName from first and last names', () => {
    const order: MedusaOrderRaw = {
      id: 'o1',
      customer: { first_name: 'Maria' },
    }
    expect(mapMedusaOrderToSummary(order).customerName).toBe('Maria')
  })

  it('returns undefined customerName when customer has empty names', () => {
    const order: MedusaOrderRaw = {
      id: 'o1',
      customer: { first_name: '', last_name: '' },
    }
    expect(mapMedusaOrderToSummary(order).customerName).toBeUndefined()
  })
})
