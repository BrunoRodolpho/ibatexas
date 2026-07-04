// Unit tests for the PURE Painel Operacional helpers (NEW-041). Covers the
// integer-centavos BRL formatter (zero, small, large/grouped, negative), the
// integer-ms duration humanizer (0/sub-minute/minutes/hours), and the
// EXHAUSTIVE pt-BR kitchen queue-status labels. No React, no network — pure
// logic. Mirrors the ops-alerts.mappers.test style.

import { describe, it, expect } from 'vitest'
import {
  formatCentavosBRL,
  formatDurationMs,
  queueStatusLabel,
  KITCHEN_QUEUE_STATUS_LABELS,
  type KitchenQueueStatus,
} from '../ops-snapshot.mappers'

const ALL_QUEUE_STATUSES: readonly KitchenQueueStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
]

// `formatBRL` renders via Intl currency; the symbol/amount separator can be a
// regular, non-breaking (U+00A0) or narrow (U+202F) space across ICU builds, so
// normalize every whitespace run to a single ASCII space before asserting.
const brl = (centavos: number): string => formatCentavosBRL(centavos).replace(/\s+/g, ' ')

describe('formatCentavosBRL (integer centavos → pt-BR BRL)', () => {
  it('formats a plain value', () => {
    expect(brl(8900)).toBe('R$ 89,00')
  })

  it('formats zero', () => {
    expect(brl(0)).toBe('R$ 0,00')
  })

  it('zero-pads the cents', () => {
    expect(brl(5)).toBe('R$ 0,05')
    expect(brl(1099)).toBe('R$ 10,99')
  })

  it('groups thousands (pt-BR "." separator) for a large value', () => {
    expect(brl(123456789)).toBe('R$ 1.234.567,89')
  })

  it('keeps a leading minus for a negative net', () => {
    expect(brl(-4500)).toBe('-R$ 45,00')
  })

  it('renders centavos with cent precision (odd centavos survive intact)', () => {
    expect(brl(101)).toBe('R$ 1,01')
  })
})

describe('formatDurationMs (integer ms → humane pt-BR)', () => {
  it('is "0 min" at zero', () => {
    expect(formatDurationMs(0)).toBe('0 min')
  })

  it('collapses a sub-minute (seconds) duration to "0 min"', () => {
    expect(formatDurationMs(45_000)).toBe('0 min')
  })

  it('floors seconds into whole minutes', () => {
    expect(formatDurationMs(90_000)).toBe('1 min')
  })

  it('formats a minutes-only duration', () => {
    expect(formatDurationMs(12 * 60_000)).toBe('12 min')
  })

  it('formats an exact-hour duration without minutes', () => {
    expect(formatDurationMs(2 * 60 * 60_000)).toBe('2 h')
  })

  it('formats an hours-and-minutes duration', () => {
    expect(formatDurationMs(65 * 60_000)).toBe('1 h 5 min')
  })

  it('clamps a negative (clock-skew) duration to "0 min"', () => {
    expect(formatDurationMs(-1000)).toBe('0 min')
  })
})

describe('queueStatusLabel (exhaustive pt-BR kitchen statuses)', () => {
  it('has a non-empty pt-BR label for every known queue status', () => {
    for (const s of ALL_QUEUE_STATUSES) {
      expect(KITCHEN_QUEUE_STATUS_LABELS[s]).toBeTruthy()
      expect(queueStatusLabel(s)).toBe(KITCHEN_QUEUE_STATUS_LABELS[s])
      expect(queueStatusLabel(s)).not.toBe(s) // never the raw enum key
    }
  })

  it('maps each status to its expected pt-BR label', () => {
    expect(queueStatusLabel('pending')).toBe('Pendente')
    expect(queueStatusLabel('confirmed')).toBe('Confirmado')
    expect(queueStatusLabel('preparing')).toBe('Preparando')
    expect(queueStatusLabel('ready')).toBe('Pronto')
  })

  it('falls back to the raw status for an unknown value (never blank)', () => {
    expect(queueStatusLabel('in_delivery')).toBe('in_delivery')
  })
})
