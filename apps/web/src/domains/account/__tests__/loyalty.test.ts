/**
 * Loyalty balance (CUS-067 web view). fetchLoyaltyBalance targets the account
 * loyalty endpoint with credentials and returns the balance; propagates errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ apiFetch: mockApiFetch }))

import { fetchLoyaltyBalance, STAMPS_FOR_REWARD } from '../loyalty'

describe('loyalty — fetchLoyaltyBalance (CUS-067)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches the loyalty endpoint with credentials and returns the balance', async () => {
    const balance = { stamps: 3, stampsNeeded: 7, totalEarned: 3 }
    mockApiFetch.mockResolvedValue(balance)
    const out = await fetchLoyaltyBalance()
    expect(out).toEqual(balance)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/me/loyalty', { credentials: 'include' })
  })

  it('propagates the API error to the caller', async () => {
    mockApiFetch.mockRejectedValue(new Error('401'))
    await expect(fetchLoyaltyBalance()).rejects.toThrow('401')
  })

  it('exposes the reward threshold', () => {
    expect(STAMPS_FOR_REWARD).toBe(10)
  })
})
