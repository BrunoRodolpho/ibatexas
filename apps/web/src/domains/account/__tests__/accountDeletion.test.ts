/**
 * LGPD account deletion (CUS-065 web view) — the client calls map 1:1 onto the
 * built server endpoints; isValidOtp gates the verify button.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ apiFetch: mockApiFetch }))

import {
  isValidOtp,
  requestDeletionOtp,
  verifyDeletionOtp,
  initiateAccountDeletion,
  cancelAccountDeletion,
} from '../accountDeletion'

describe('accountDeletion — isValidOtp (CUS-065)', () => {
  it('accepts a 6-digit code', () => {
    expect(isValidOtp('123456')).toBe(true)
    expect(isValidOtp(' 123456 ')).toBe(true)
  })
  it('rejects anything that is not 6 digits', () => {
    for (const t of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(isValidOtp(t)).toBe(false)
    }
  })
})

describe('accountDeletion — flow calls (CUS-065)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApiFetch.mockResolvedValue({})
  })

  it('requestDeletionOtp POSTs send-otp', async () => {
    await requestDeletionOtp()
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/data/send-otp',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('verifyDeletionOtp POSTs the trimmed token', async () => {
    await verifyDeletionOtp(' 123456 ')
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/data/verify-otp',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: '123456' }) }),
    )
  })

  it('initiateAccountDeletion POSTs initiate-deletion', async () => {
    await initiateAccountDeletion()
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/data/initiate-deletion',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('cancelAccountDeletion POSTs cancel-deletion', async () => {
    await cancelAccountDeletion()
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/data/cancel-deletion',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('propagates a verify error (bad code → 401 throws)', async () => {
    mockApiFetch.mockRejectedValue(new Error('API error: 401'))
    await expect(verifyDeletionOtp('000000')).rejects.toThrow()
  })
})
