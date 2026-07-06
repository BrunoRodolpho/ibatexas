/**
 * Editable profile (CUS-061 web view). fetchProfile reads name/email from the
 * auth profile; saveProfile POSTs only the non-empty fields through the governed
 * route (never a blank email — the server 400s on that); isValidEmail gates the
 * form so the customer never hits a server 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ apiFetch: mockApiFetch }))

import { fetchProfile, saveProfile, isValidEmail } from '../profile'

describe('profile — fetchProfile (CUS-061)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns name/email from the auth profile', async () => {
    mockApiFetch.mockResolvedValue({ name: 'Maria', email: 'm@x.com' })
    expect(await fetchProfile()).toEqual({ name: 'Maria', email: 'm@x.com' })
    expect(mockApiFetch).toHaveBeenCalledWith('/api/auth/me', { credentials: 'include' })
  })

  it('defaults missing fields to empty strings', async () => {
    mockApiFetch.mockResolvedValue({ name: null })
    expect(await fetchProfile()).toEqual({ name: '', email: '' })
  })

  it('defaults (does not throw) on a read error', async () => {
    mockApiFetch.mockRejectedValue(new Error('500'))
    expect(await fetchProfile()).toEqual({ name: '', email: '' })
  })
})

describe('profile — isValidEmail (CUS-061)', () => {
  it('accepts empty (optional) and well-formed addresses', () => {
    expect(isValidEmail('')).toBe(true)
    expect(isValidEmail('  ')).toBe(true)
    expect(isValidEmail('maria@example.com')).toBe(true)
  })
  it('rejects malformed addresses', () => {
    for (const e of ['no-at', 'a@b', 'a@b.', '@x.com', 'a b@x.com']) {
      expect(isValidEmail(e)).toBe(false)
    }
  })
})

describe('profile — saveProfile (CUS-061)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POSTs only the non-empty, trimmed fields', async () => {
    mockApiFetch.mockResolvedValue({ success: true })
    await saveProfile({ name: '  Maria Silva ', email: '' })
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/profile',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Maria Silva' }),
      }),
    )
  })

  it('sends both fields when both are present', async () => {
    mockApiFetch.mockResolvedValue({ success: true })
    await saveProfile({ name: 'Ana', email: 'ana@x.com' })
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/profile',
      expect.objectContaining({ body: JSON.stringify({ name: 'Ana', email: 'ana@x.com' }) }),
    )
  })

  it('is a no-op (no request) when both fields are blank', async () => {
    await saveProfile({ name: '   ', email: '' })
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})
