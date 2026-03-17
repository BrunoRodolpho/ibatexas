import { describe, it, expect } from 'vitest'
import { getCrossSellCategory, CROSS_SELL_MAP } from '../cross-sell'

// ── CROSS_SELL_MAP structure ────────────────────────────────────────────

describe('CROSS_SELL_MAP', () => {
  it('contains expected category keys', () => {
    const expectedKeys = [
      'carnes-defumadas', 'sanduiches', 'acompanhamentos',
      'sobremesas', 'bebidas', 'congelados', 'kits', 'camisetas',
    ]
    expect(Object.keys(CROSS_SELL_MAP).sort()).toEqual(expectedKeys.sort())
  })

  it('every entry is a non-empty array of strings', () => {
    for (const [key, pairings] of Object.entries(CROSS_SELL_MAP)) {
      expect(Array.isArray(pairings), `${key} should map to an array`).toBe(true)
      expect(pairings.length, `${key} should have at least one pairing`).toBeGreaterThan(0)
      for (const p of pairings) {
        expect(typeof p).toBe('string')
      }
    }
  })

  it('carnes-defumadas pairs with acompanhamentos and bebidas', () => {
    expect(CROSS_SELL_MAP['carnes-defumadas']).toEqual(['acompanhamentos', 'bebidas'])
  })

  it('sobremesas pairs only with bebidas', () => {
    expect(CROSS_SELL_MAP['sobremesas']).toEqual(['bebidas'])
  })

  it('camisetas (merchandise) cross-sells to carnes-defumadas and kits', () => {
    expect(CROSS_SELL_MAP['camisetas']).toEqual(['carnes-defumadas', 'kits'])
  })
})

// ── getCrossSellCategory ────────────────────────────────────────────────

describe('getCrossSellCategory', () => {
  it('returns the first pairing for carnes-defumadas', () => {
    expect(getCrossSellCategory('carnes-defumadas')).toBe('acompanhamentos')
  })

  it('returns the first pairing for sanduiches', () => {
    expect(getCrossSellCategory('sanduiches')).toBe('acompanhamentos')
  })

  it('returns the first pairing for bebidas', () => {
    expect(getCrossSellCategory('bebidas')).toBe('carnes-defumadas')
  })

  it('returns the first pairing for congelados', () => {
    expect(getCrossSellCategory('congelados')).toBe('acompanhamentos')
  })

  it('returns the first pairing for kits', () => {
    expect(getCrossSellCategory('kits')).toBe('bebidas')
  })

  it('returns the first pairing for camisetas', () => {
    expect(getCrossSellCategory('camisetas')).toBe('carnes-defumadas')
  })

  it('returns undefined for unknown category', () => {
    expect(getCrossSellCategory('categoria-inexistente')).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(getCrossSellCategory('')).toBeUndefined()
  })

  it('is case-sensitive — "Carnes-Defumadas" is unknown', () => {
    expect(getCrossSellCategory('Carnes-Defumadas')).toBeUndefined()
  })
})
