/**
 * Dietary preferences (CUS-062 web view). fetchPreferences reads from the
 * portability export, defaulting to empty ONLY for a genuine no-preferences
 * record — a read FAILURE returns null so the card renders a retry state
 * (an empty-but-saveable form would wipe stored allergen exclusions);
 * savePreferences POSTs the FULL set (dietaryFlags → dietaryRestrictions)
 * so a dietary-only edit preserves the allergen + favorite lists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ apiFetch: mockApiFetch }))

import { fetchPreferences, savePreferences, DIETARY_FLAGS } from '../preferences'

describe('preferences — fetchPreferences (CUS-062)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the stored preferences from the export endpoint', async () => {
    const prefs = { dietaryRestrictions: ['vegano'], allergenExclusions: ['gluten'], favoriteCategories: [] }
    mockApiFetch.mockResolvedValue({ preferences: prefs })
    expect(await fetchPreferences()).toEqual(prefs)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/me/data', { credentials: 'include' })
  })

  it('defaults to empty arrays when the customer has no preferences', async () => {
    mockApiFetch.mockResolvedValue({ preferences: null })
    expect(await fetchPreferences()).toEqual({
      dietaryRestrictions: [],
      allergenExclusions: [],
      favoriteCategories: [],
    })
  })

  it('returns null (NOT empty defaults) on a read error so the form is never submittable from a failed load', async () => {
    // Empty defaults here would let one toggle+save POST allergenExclusions: []
    // and permanently erase the customer's stored allergen exclusions.
    mockApiFetch.mockRejectedValue(new Error('500'))
    expect(await fetchPreferences()).toBeNull()
  })
})

describe('preferences — savePreferences (CUS-062)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POSTs the FULL set so sibling fields are preserved', async () => {
    mockApiFetch.mockResolvedValue({ success: true })
    await savePreferences({
      dietaryRestrictions: ['vegano'],
      allergenExclusions: ['gluten', 'lactose'],
      favoriteCategories: ['bebidas'],
    })
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/preferences',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          allergenExclusions: ['gluten', 'lactose'],
          dietaryFlags: ['vegano'],
          favoriteCategories: ['bebidas'],
        }),
      }),
    )
  })

  it('exposes the offered dietary flags', () => {
    expect(DIETARY_FLAGS).toContain('vegetariano')
    expect(DIETARY_FLAGS).toContain('sem_gluten')
  })
})
