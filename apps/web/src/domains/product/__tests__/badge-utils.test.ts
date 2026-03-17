import { describe, it, expect } from 'vitest'
import { tagToBadgeVariant, type BadgeVariant } from '../badge-utils'

// ── Known tags ──────────────────────────────────────────────────────────

describe('tagToBadgeVariant', () => {
  describe('hero tier tags', () => {
    it('maps "popular" → "popular"', () => {
      expect(tagToBadgeVariant('popular')).toBe('popular')
    })

    it('maps "chef_choice" → "chef_choice"', () => {
      expect(tagToBadgeVariant('chef_choice')).toBe('chef_choice')
    })

    it('maps "edicao_limitada" → "edicao_limitada"', () => {
      expect(tagToBadgeVariant('edicao_limitada')).toBe('edicao_limitada')
    })
  })

  describe('feature tier tags', () => {
    it('maps "novo" → "novo"', () => {
      expect(tagToBadgeVariant('novo')).toBe('novo')
    })

    it('maps "exclusivo" → "exclusivo"', () => {
      expect(tagToBadgeVariant('exclusivo')).toBe('exclusivo')
    })

    it('maps "kit" → "kit"', () => {
      expect(tagToBadgeVariant('kit')).toBe('kit')
    })
  })

  describe('informational tier tags', () => {
    it('maps "vegetariano" → "vegetariano"', () => {
      expect(tagToBadgeVariant('vegetariano')).toBe('vegetariano')
    })

    it('maps "vegan" → "vegan"', () => {
      expect(tagToBadgeVariant('vegan')).toBe('vegan')
    })

    it('maps "sem_gluten" → "sem_gluten"', () => {
      expect(tagToBadgeVariant('sem_gluten')).toBe('sem_gluten')
    })

    it('maps "sem_lactose" → "sem_lactose"', () => {
      expect(tagToBadgeVariant('sem_lactose')).toBe('sem_lactose')
    })
  })

  // ── Unknown / fallback ──────────────────────────────────────────────

  describe('fallback behavior', () => {
    it('returns "info" for unknown tags', () => {
      expect(tagToBadgeVariant('desconhecido')).toBe('info')
    })

    it('returns "info" for empty string', () => {
      expect(tagToBadgeVariant('')).toBe('info')
    })

    it('is case-sensitive — "Popular" is unknown', () => {
      expect(tagToBadgeVariant('Popular')).toBe('info')
    })

    it('does not trim whitespace — " popular " is unknown', () => {
      expect(tagToBadgeVariant(' popular ')).toBe('info')
    })

    it('returns "info" for tags with special characters', () => {
      expect(tagToBadgeVariant('popular!')).toBe('info')
    })
  })

  // ── Type safety ────────────────────────────────────────────────────

  describe('return type', () => {
    it('returns a valid BadgeVariant for every known tag', () => {
      const knownTags = [
        'popular', 'chef_choice', 'edicao_limitada',
        'novo', 'exclusivo', 'kit',
        'vegetariano', 'vegan', 'sem_gluten', 'sem_lactose',
      ]
      for (const tag of knownTags) {
        const result: BadgeVariant = tagToBadgeVariant(tag)
        expect(result).toBeTruthy()
        expect(result).not.toBe('info') // known tags should not fallback
      }
    })
  })
})
