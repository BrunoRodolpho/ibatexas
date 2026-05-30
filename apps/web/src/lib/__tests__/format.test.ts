/**
 * Tests for price formatting utilities.
 * These are pure functions — no mocks needed.
 */

import { describe, it, expect } from 'vitest'
import { formatBRL, formatPerPerson, splitBRL } from '../format'

describe('Format Utilities', () => {
  // ── formatBRL() ───────────────────────────────────────────────────────────

  describe('formatBRL()', () => {
    it('formats centavos to BRL string', () => {
      expect(formatBRL(8900)).toBe('R$\u00a089,00')
    })

    it('formats zero', () => {
      expect(formatBRL(0)).toBe('R$\u00a00,00')
    })

    it('formats large values with thousands separator', () => {
      const result = formatBRL(1234500)
      // pt-BR uses dot as thousands separator
      expect(result).toContain('12.345')
    })

    it('formats fractional centavos', () => {
      expect(formatBRL(1)).toContain('0,01')
    })
  })

  // ── formatPerPerson() ─────────────────────────────────────────────────────

  describe('formatPerPerson()', () => {
    it('divides price by servings count', () => {
      const result = formatPerPerson(8900, 4)
      // 8900 / 100 / 4 = 22.25
      expect(result).toContain('22,25')
    })

    it('returns full price when servings is 1', () => {
      const result = formatPerPerson(8900, 1)
      expect(result).toContain('89,00')
    })

    it('returns full price when servings is 0 (guard)', () => {
      const result = formatPerPerson(8900, 0)
      expect(result).toContain('89,00')
    })

    it('returns full price when servings is negative (guard)', () => {
      const result = formatPerPerson(8900, -2)
      expect(result).toContain('89,00')
    })
  })

  // ── splitBRL() ────────────────────────────────────────────────────────────

  describe('splitBRL()', () => {
    it('splits into prefix and value', () => {
      expect(splitBRL(8900)).toEqual({ prefix: 'R$', value: '89,00' })
    })

    it('handles zero', () => {
      expect(splitBRL(0)).toEqual({ prefix: 'R$', value: '0,00' })
    })

    it('handles sub-real values', () => {
      expect(splitBRL(50)).toEqual({ prefix: 'R$', value: '0,50' })
    })

    it('includes thousands separator for large values', () => {
      // 1_500_000 centavos = R$15.000,00 — dot is pt-BR thousands separator
      expect(splitBRL(1500000)).toEqual({ prefix: 'R$', value: '15.000,00' })
    })

    it('includes thousands separator for very large values', () => {
      // 12_345_600 centavos = R$123.456,00
      const result = splitBRL(12345600)
      expect(result.prefix).toBe('R$')
      expect(result.value).toBe('123.456,00')
    })
  })
})
