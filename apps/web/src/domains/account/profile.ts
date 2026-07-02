/**
 * Editable profile (CUS-061, web view). Reads the current name/email from the
 * auth profile and saves changes through the governed POST /api/me/profile
 * (adjudicated: auth + PII scan + 1h rate-limit).
 */

import { apiFetch } from '@/lib/api'

export interface EditableProfile {
  readonly name: string
  readonly email: string
}

const EMPTY_PROFILE: EditableProfile = { name: '', email: '' }

/** Current name/email, defaulting to empty strings (form still renders on error). */
export async function fetchProfile(): Promise<EditableProfile> {
  try {
    const data = await apiFetch<{ name?: string | null; email?: string | null }>('/api/auth/me', {
      credentials: 'include',
    })
    return { name: data.name ?? '', email: data.email ?? '' }
  } catch {
    return EMPTY_PROFILE
  }
}

/** True when the email is empty (allowed — optional) or a plausible address. */
export function isValidEmail(email: string): boolean {
  const trimmed = email.trim()
  if (trimmed === '') return true
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
}

/**
 * Persist the changed fields through POST /api/me/profile. Only sends a field
 * that is non-empty (the server requires at least one and rejects a blank
 * email); an all-empty edit is a no-op that resolves without a request.
 */
export async function saveProfile(profile: EditableProfile): Promise<void> {
  const name = profile.name.trim()
  const email = profile.email.trim()
  const body: { name?: string; email?: string } = {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  }
  if (body.name === undefined && body.email === undefined) return
  await apiFetch('/api/me/profile', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify(body),
  })
}
