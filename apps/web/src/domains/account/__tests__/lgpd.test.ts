/**
 * LGPD self-service (CUS-064). fetchMyData targets the portability API and
 * surfaces the API's errors (incl. the 409 lock-contention case) to the caller;
 * downloadAsJson is a safe no-op outside a DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ apiFetch: mockApiFetch }))

import { fetchMyData, downloadAsJson, LGPD_EXPORT_FILENAME } from '../lgpd'

describe('lgpd — fetchMyData (CUS-064)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches the portability endpoint with credentials and returns the payload', async () => {
    const payload = { profile: { id: 'c1' }, orders: [] }
    mockApiFetch.mockResolvedValue(payload)
    const out = await fetchMyData()
    expect(out).toEqual(payload)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/me/data', { credentials: 'include' })
  })

  it('propagates the API error (e.g. 409 lock contention) to the caller', async () => {
    mockApiFetch.mockRejectedValue(new Error('Conflict'))
    await expect(fetchMyData()).rejects.toThrow('Conflict')
  })
})

describe('lgpd — downloadAsJson', () => {
  it('exposes a stable default filename', () => {
    expect(LGPD_EXPORT_FILENAME).toBe('ibatexas-meus-dados.json')
  })

  it('is a safe no-op when object URLs are unavailable', () => {
    const original = globalThis.URL.createObjectURL
    // @ts-expect-error — force the guard branch
    globalThis.URL.createObjectURL = undefined
    expect(() => downloadAsJson({ a: 1 })).not.toThrow()
    globalThis.URL.createObjectURL = original
  })
})
