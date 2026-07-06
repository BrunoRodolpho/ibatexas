import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks — the component is invoked as a plain function (the web pattern; no
//    RTL). We control the specials data + the mapper output, and stub next-intl. ──

const mockUseSpecials = vi.hoisted(() => vi.fn())
const mockToDisplay = vi.hoisted(() => vi.fn())

vi.mock('@/domains/specials', () => ({
  useSpecials: mockUseSpecials,
  toSpecialsDisplay: mockToDisplay,
}))
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
// The atoms are only used as JSX element TYPES (jsx() never invokes them), so
// stubs suffice — and they cut the real atoms' transitive next/navigation import
// that fails to resolve under the vitest module env.
vi.mock('@/components/atoms', () => ({
  Container: ({ children }: { children?: unknown }) => children,
  Text: ({ children }: { children?: unknown }) => children,
}))

import { HomeSpecials } from '../HomeSpecials'

beforeEach(() => vi.clearAllMocks())

describe('HomeSpecials', () => {
  it('renders null when there are no active specials (invisible on empty data)', () => {
    mockUseSpecials.mockReturnValue({ data: null })
    mockToDisplay.mockReturnValue([])
    expect(HomeSpecials()).toBeNull()
    // the fetched data is threaded to the mapper
    expect(mockToDisplay).toHaveBeenCalledWith(null)
  })

  it('renders a tree when specials exist (maps rows; headline + promo price both optional)', () => {
    mockUseSpecials.mockReturnValue({ data: { specials: [{ productId: 'p1' }] } })
    mockToDisplay.mockReturnValue([
      { productId: 'p1', headline: 'Feijoada da casa', promoPrice: 'R$ 49,00' },
      { productId: 'p2', headline: null, promoPrice: null },
    ])
    const result = HomeSpecials()
    expect(result).not.toBeNull()
    expect(mockToDisplay).toHaveBeenCalledWith({ specials: [{ productId: 'p1' }] })
  })
})
