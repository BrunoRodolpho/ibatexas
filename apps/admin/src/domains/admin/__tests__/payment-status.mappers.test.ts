// Unit tests for the PURE OPS-011 forced-payment-status helpers. No React, no
// network — pure logic. Covers the closed 12-value set (must mirror the step-1
// route's z.enum), the pt-BR labels + RAW fallback, the ready-to-render option
// rows, and the type guard. Mirrors the order-notes.mappers.test style
// (invoke-as-function; apps/admin has no @testing-library/react).

import { describe, it, expect } from 'vitest'
import {
  FORCE_STATUS_VALUES,
  FORCE_STATUS_OPTIONS,
  forceStatusLabel,
  isForceStatusValue,
} from '../payment-status.mappers'

describe('FORCE_STATUS_VALUES', () => {
  it('is exactly the 12 route-enum statuses in order', () => {
    expect([...FORCE_STATUS_VALUES]).toEqual([
      'awaiting_payment',
      'payment_pending',
      'payment_expired',
      'payment_failed',
      'cash_pending',
      'paid',
      'switching_method',
      'partially_refunded',
      'refunded',
      'disputed',
      'canceled',
      'waived',
    ])
  })

  it('has no duplicate values', () => {
    expect(new Set(FORCE_STATUS_VALUES).size).toBe(FORCE_STATUS_VALUES.length)
  })
})

describe('forceStatusLabel', () => {
  it('maps known statuses to pt-BR labels', () => {
    expect(forceStatusLabel('paid')).toBe('Pago')
    expect(forceStatusLabel('refunded')).toBe('Reembolsado')
    expect(forceStatusLabel('cash_pending')).toBe('Dinheiro (pendente)')
    expect(forceStatusLabel('waived')).toBe('Isento')
  })

  it('falls back to the raw value for an unknown status (never blank)', () => {
    expect(forceStatusLabel('mystery_status')).toBe('mystery_status')
  })
})

describe('FORCE_STATUS_OPTIONS', () => {
  it('yields one {value,label} row per status, in enum order', () => {
    expect(FORCE_STATUS_OPTIONS.map((o) => o.value)).toEqual([...FORCE_STATUS_VALUES])
    for (const opt of FORCE_STATUS_OPTIONS) {
      expect(opt.label).toBe(forceStatusLabel(opt.value))
      expect(opt.label.length).toBeGreaterThan(0)
    }
  })
})

describe('isForceStatusValue', () => {
  it('accepts forceable statuses and rejects everything else', () => {
    expect(isForceStatusValue('paid')).toBe(true)
    expect(isForceStatusValue('disputed')).toBe(true)
    expect(isForceStatusValue('')).toBe(false)
    expect(isForceStatusValue('delivered')).toBe(false)
  })
})
