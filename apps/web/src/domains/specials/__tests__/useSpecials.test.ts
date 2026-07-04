import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockApiFetch = vi.hoisted(() => vi.fn())

vi.mock('@/lib/useQuery', () => ({ useQuery: mockUseQuery }))
vi.mock('@/lib/api', () => ({ apiFetch: mockApiFetch }))

import { useSpecials } from '../useSpecials'

beforeEach(() => vi.clearAllMocks())

describe('useSpecials', () => {
  it("queries 'specials-today' and fetches GET /api/specials/today (empty deps)", () => {
    mockUseQuery.mockReturnValue({ data: null, loading: false, error: null })

    useSpecials()

    expect(mockUseQuery).toHaveBeenCalledTimes(1)
    const [key, fetcher, deps] = mockUseQuery.mock.calls[0]!
    expect(key).toBe('specials-today')
    expect(deps).toEqual([])

    // The fetcher forwards the AbortSignal to apiFetch at the public specials URL.
    const signal = new AbortController().signal
    ;(fetcher as (s: AbortSignal) => unknown)(signal)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/specials/today', { signal })
  })
})
