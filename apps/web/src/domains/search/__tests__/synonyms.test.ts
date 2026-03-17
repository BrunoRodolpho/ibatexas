import { describe, it, expect } from 'vitest'
import { resolveCanonical, SYNONYM_GROUPS } from '../synonyms'

// ── SYNONYM_GROUPS structure ────────────────────────────────────────────

describe('SYNONYM_GROUPS', () => {
  it('is a non-empty array', () => {
    expect(SYNONYM_GROUPS.length).toBeGreaterThan(0)
  })

  it('every group has a non-empty canonical and at least one synonym', () => {
    for (const group of SYNONYM_GROUPS) {
      expect(group.canonical.length).toBeGreaterThan(0)
      expect(group.synonyms.length).toBeGreaterThan(0)
      for (const syn of group.synonyms) {
        expect(typeof syn).toBe('string')
        expect(syn.length).toBeGreaterThan(0)
      }
    }
  })

  it('no duplicate canonical terms', () => {
    const canonicals = SYNONYM_GROUPS.map((g) => g.canonical.toLowerCase())
    const unique = new Set(canonicals)
    expect(unique.size).toBe(canonicals.length)
  })
})

// ── resolveCanonical ────────────────────────────────────────────────────

describe('resolveCanonical', () => {
  // ── Exact canonical match ──────────────────────────────────────────

  it('returns canonical for exact canonical input', () => {
    expect(resolveCanonical('peito bovino defumado')).toBe('peito bovino defumado')
  })

  it('returns canonical for "costela defumada"', () => {
    expect(resolveCanonical('costela defumada')).toBe('costela defumada')
  })

  it('returns canonical for "pulled pork"', () => {
    expect(resolveCanonical('pulled pork')).toBe('pulled pork')
  })

  // ── Synonym → canonical resolution ────────────────────────────────

  it('resolves "brisket" → "peito bovino defumado"', () => {
    expect(resolveCanonical('brisket')).toBe('peito bovino defumado')
  })

  it('resolves "peito defumado" → "peito bovino defumado"', () => {
    expect(resolveCanonical('peito defumado')).toBe('peito bovino defumado')
  })

  it('resolves "ribs" → "costela defumada"', () => {
    expect(resolveCanonical('ribs')).toBe('costela defumada')
  })

  it('resolves "costelinha" → "costela defumada"', () => {
    expect(resolveCanonical('costelinha')).toBe('costela defumada')
  })

  it('resolves "baby back ribs" → "costela defumada"', () => {
    expect(resolveCanonical('baby back ribs')).toBe('costela defumada')
  })

  it('resolves "sausage" → "linguiça defumada"', () => {
    expect(resolveCanonical('sausage')).toBe('linguiça defumada')
  })

  it('resolves "linguica" (without accent) → "linguiça defumada"', () => {
    expect(resolveCanonical('linguica')).toBe('linguiça defumada')
  })

  it('resolves "porco desfiado" → "pulled pork"', () => {
    expect(resolveCanonical('porco desfiado')).toBe('pulled pork')
  })

  it('resolves "macarrão com queijo" → "mac and cheese"', () => {
    expect(resolveCanonical('macarrão com queijo')).toBe('mac and cheese')
  })

  it('resolves "mac n cheese" → "mac and cheese"', () => {
    expect(resolveCanonical('mac n cheese')).toBe('mac and cheese')
  })

  it('resolves "mac & cheese" → "mac and cheese"', () => {
    expect(resolveCanonical('mac & cheese')).toBe('mac and cheese')
  })

  // ── Case insensitivity ────────────────────────────────────────────

  it('is case-insensitive for synonyms', () => {
    expect(resolveCanonical('BRISKET')).toBe('peito bovino defumado')
    expect(resolveCanonical('Brisket')).toBe('peito bovino defumado')
  })

  it('is case-insensitive for canonical terms', () => {
    expect(resolveCanonical('PULLED PORK')).toBe('pulled pork')
    expect(resolveCanonical('Pulled Pork')).toBe('pulled pork')
  })

  // ── Whitespace handling ───────────────────────────────────────────

  it('trims leading and trailing whitespace', () => {
    expect(resolveCanonical('  brisket  ')).toBe('peito bovino defumado')
  })

  it('trims tabs and newlines', () => {
    expect(resolveCanonical('\tbrisket\n')).toBe('peito bovino defumado')
  })

  // ── No match ──────────────────────────────────────────────────────

  it('returns undefined for unknown terms', () => {
    expect(resolveCanonical('pizza')).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(resolveCanonical('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only input', () => {
    expect(resolveCanonical('   ')).toBeUndefined()
  })

  it('returns undefined for partial match (substring)', () => {
    expect(resolveCanonical('bris')).toBeUndefined()
  })

  it('returns undefined for partial synonym (extra words)', () => {
    expect(resolveCanonical('brisket defumado')).toBeUndefined()
  })
})
