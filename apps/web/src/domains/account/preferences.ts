/**
 * Dietary preferences / allergen profile (CUS-062, web view).
 *
 * Load-all + save-all so a partial edit never wipes sibling fields
 * (allergenExclusions / favoriteCategories are preserved on save).
 */

import { apiFetch } from '@/lib/api'

export interface CustomerPreferences {
  readonly dietaryRestrictions: string[]
  readonly allergenExclusions: string[]
  readonly favoriteCategories: string[]
}

const EMPTY_PREFERENCES: CustomerPreferences = {
  dietaryRestrictions: [],
  allergenExclusions: [],
  favoriteCategories: [],
}

/** The dietary flags offered as toggles (pt-BR labels live in the i18n bundle). */
export const DIETARY_FLAGS = ['vegetariano', 'vegano', 'sem_gluten', 'sem_lactose'] as const

/**
 * Current preferences, sourced from the portability export (the only endpoint
 * that returns the stored preference record). Returns empty defaults when the
 * customer has none yet; returns null on a read FAILURE so callers render a
 * retry state instead of an empty editable form — saving from failure-empty
 * defaults would POST `allergenExclusions: []` and wipe the stored allergen
 * exclusions (the server treats a defined-empty array as replace).
 */
export async function fetchPreferences(): Promise<CustomerPreferences | null> {
  try {
    const data = (await apiFetch<{ preferences: CustomerPreferences | null }>('/api/me/data', {
      credentials: 'include',
    }))
    return data.preferences ?? EMPTY_PREFERENCES
  } catch {
    return null
  }
}

/**
 * Persist the full preference set through the governed POST /api/me/preferences
 * (dietaryFlags → dietaryRestrictions server-side). Sends every field so a
 * dietary-only edit preserves the allergen + favorite lists.
 */
export async function savePreferences(prefs: CustomerPreferences): Promise<void> {
  await apiFetch('/api/me/preferences', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({
      allergenExclusions: prefs.allergenExclusions,
      dietaryFlags: prefs.dietaryRestrictions,
      favoriteCategories: prefs.favoriteCategories,
    }),
  })
}
