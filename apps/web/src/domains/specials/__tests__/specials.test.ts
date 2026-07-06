import { describe, it, expect } from 'vitest'
import { toSpecialsDisplay } from '../specials'

// ── toSpecialsDisplay — pure transform of the public specials response ────────

describe('toSpecialsDisplay', () => {
  it('returns [] for null/undefined/malformed responses (empty-safe)', () => {
    expect(toSpecialsDisplay(null)).toEqual([])
    expect(toSpecialsDisplay(undefined)).toEqual([])
    // `specials` missing / not an array → []
    expect(toSpecialsDisplay({} as never)).toEqual([])
    expect(toSpecialsDisplay({ specials: 'nope' } as never)).toEqual([])
    expect(toSpecialsDisplay({ specials: [] })).toEqual([])
  })

  it('formats the integer-centavos promo price to BRL (never a raw integer)', () => {
    const rows = toSpecialsDisplay({
      specials: [{ productId: 'prod_1', promoPriceCentavos: 4900, headline: 'Feijoada' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ productId: 'prod_1', headline: 'Feijoada' })
    // formatBRL(4900) → "R$ 49,00" (a non-breaking space between R$ and the number).
    expect(rows[0]!.promoPrice).toContain('49,00')
    expect(rows[0]!.promoPrice).toContain('R$')
    // never the raw centavos integer
    expect(rows[0]!.promoPrice).not.toBe('4900')
  })

  it('null promo price (featured, no discount) → promoPrice: null', () => {
    const rows = toSpecialsDisplay({
      specials: [{ productId: 'prod_2', promoPriceCentavos: null, headline: 'Costela do dia' }],
    })
    expect(rows[0]).toEqual({ productId: 'prod_2', headline: 'Costela do dia', promoPrice: null })
  })

  it('empty/missing headline → headline: null (no empty string in the UI)', () => {
    const rows = toSpecialsDisplay({
      specials: [
        { productId: 'prod_3', promoPriceCentavos: 1000, headline: '' },
        { productId: 'prod_4', promoPriceCentavos: 1000, headline: null },
      ],
    })
    expect(rows[0]!.headline).toBeNull()
    expect(rows[1]!.headline).toBeNull()
  })

  it('skips a row with no usable productId (can not key/link it) and preserves order', () => {
    const rows = toSpecialsDisplay({
      specials: [
        { productId: 'a', promoPriceCentavos: 100, headline: 'A' },
        { productId: '', promoPriceCentavos: 200, headline: 'no-id' },
        { productId: 'b', promoPriceCentavos: 300, headline: 'B' },
      ],
    })
    expect(rows.map((r) => r.productId)).toEqual(['a', 'b'])
  })
})
