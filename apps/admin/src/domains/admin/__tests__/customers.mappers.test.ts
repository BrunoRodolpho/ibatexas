// Unit tests for the PURE Clientes helpers (OPS-070). No React, no network —
// pure logic. Covers the integer-centavos BRL formatter, the BR phone/CPF/CEP
// formatters (incl. the LGPD CPF mask), the pt-BR label maps (source / order /
// payment / delivery / method), the opt-out badge, the address one-liner and the
// missing-value placeholder. Mirrors the ops-snapshot.mappers.test style.

import { describe, it, expect } from 'vitest'
import {
  formatCentavosBRL,
  formatPhoneBR,
  formatCpfMasked,
  formatCep,
  orDash,
  sourceLabel,
  orderStatusLabel,
  paymentStatusLabel,
  deliveryTypeLabel,
  paymentMethodLabel,
  optOutBadge,
  formatAddressLine,
  formatDateBR,
  type AdminCustomerAddress,
} from '../customers.mappers'

// formatBRL renders via Intl currency; the separator can be a regular, non-
// breaking (U+00A0) or narrow (U+202F) space across ICU builds — normalize.
const brl = (c: number): string => formatCentavosBRL(c).replace(/\s+/g, ' ')

describe('formatCentavosBRL', () => {
  it('formats a plain value and zero-pads cents', () => {
    expect(brl(8900)).toBe('R$ 89,00')
    expect(brl(5)).toBe('R$ 0,05')
  })
  it('guards a non-finite value to R$ 0,00', () => {
    expect(brl(Number.NaN)).toBe('R$ 0,00')
  })
})

describe('formatPhoneBR', () => {
  it('formats a 13-digit BR mobile (+55 DD 9XXXXXXXX)', () => {
    expect(formatPhoneBR('+5511999990001')).toBe('(11) 99999-0001')
  })
  it('formats a 12-digit BR landline (+55 DD XXXXXXXX)', () => {
    expect(formatPhoneBR('+551133334444')).toBe('(11) 3333-4444')
  })
  it('returns the raw value for a non-BR / unexpected shape', () => {
    expect(formatPhoneBR('12345')).toBe('12345')
  })
  it('renders the em-dash for a null / empty phone', () => {
    expect(formatPhoneBR(null)).toBe('—')
    expect(formatPhoneBR('   ')).toBe('—')
  })
})

describe('formatCpfMasked (LGPD — only the last 2 digits shown)', () => {
  it('masks all but the last two digits', () => {
    expect(formatCpfMasked('123.456.789-00')).toBe('•••.•••.•••-00')
    expect(formatCpfMasked('12345678900')).toBe('•••.•••.•••-00')
  })
  it('never reveals the leading digits', () => {
    expect(formatCpfMasked('123.456.789-00')).not.toContain('123')
    expect(formatCpfMasked('123.456.789-00')).not.toContain('456')
  })
  it('renders the em-dash for a null / too-short CPF', () => {
    expect(formatCpfMasked(null)).toBe('—')
    expect(formatCpfMasked('7')).toBe('—')
  })
})

describe('formatCep', () => {
  it('formats an 8-digit CEP', () => {
    expect(formatCep('01000000')).toBe('01000-000')
  })
  it('returns empty for null and verbatim for an odd length', () => {
    expect(formatCep(null)).toBe('')
    expect(formatCep('123')).toBe('123')
  })
})

describe('orDash', () => {
  it('returns the value when present and the em-dash otherwise', () => {
    expect(orDash('Maria')).toBe('Maria')
    expect(orDash('  ')).toBe('—')
    expect(orDash(null)).toBe('—')
  })
})

describe('sourceLabel', () => {
  it('maps known channels and capitalizes unknowns', () => {
    expect(sourceLabel('whatsapp')).toBe('WhatsApp')
    expect(sourceLabel('web')).toBe('Site')
    expect(sourceLabel('kiosk')).toBe('Kiosk')
    expect(sourceLabel(null)).toBe('—')
  })
})

describe('status / payment / delivery / method labels', () => {
  it('maps order fulfillment status (raw fallback)', () => {
    expect(orderStatusLabel('preparing')).toBe('preparando')
    expect(orderStatusLabel('mystery')).toBe('mystery')
  })
  it('maps payment status with an em-dash for null', () => {
    expect(paymentStatusLabel('captured')).toBe('pago')
    expect(paymentStatusLabel(null)).toBe('—')
  })
  it('maps delivery type and payment method', () => {
    expect(deliveryTypeLabel('delivery')).toBe('Entrega')
    expect(deliveryTypeLabel('pickup')).toBe('Retirada')
    expect(deliveryTypeLabel(null)).toBe('—')
    expect(paymentMethodLabel('pix')).toBe('PIX')
    expect(paymentMethodLabel('card')).toBe('Cartão')
    expect(paymentMethodLabel(null)).toBe('—')
  })
})

describe('optOutBadge', () => {
  it('is an amber warning when opted-out', () => {
    expect(optOutBadge(true)).toEqual({ label: 'Não recebe marketing', variant: 'warning' })
  })
  it('is a neutral default when opted-in', () => {
    expect(optOutBadge(false)).toEqual({ label: 'Recebe marketing', variant: 'default' })
  })
})

describe('formatAddressLine', () => {
  const base: AdminCustomerAddress = {
    id: 'a1',
    street: 'Rua A',
    number: '100',
    complement: 'Apto 5',
    district: 'Centro',
    city: 'São Paulo',
    state: 'SP',
    cep: '01000000',
    isDefault: true,
  }

  it('collapses a full address to one line with the complement', () => {
    expect(formatAddressLine(base)).toBe('Rua A, 100 — Apto 5, Centro, São Paulo/SP, CEP 01000-000')
  })
  it('omits the complement segment when absent', () => {
    expect(formatAddressLine({ ...base, complement: null })).toBe(
      'Rua A, 100, Centro, São Paulo/SP, CEP 01000-000',
    )
  })
})

describe('formatDateBR', () => {
  it('renders the em-dash for a null date', () => {
    expect(formatDateBR(null)).toBe('—')
  })
  it('formats an ISO date to a pt-BR short date', () => {
    // Assert the pt-BR dd/mm/yyyy shape without pinning the timezone-sensitive day.
    expect(formatDateBR('2026-06-15T12:00:00.000Z')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)
  })
})
