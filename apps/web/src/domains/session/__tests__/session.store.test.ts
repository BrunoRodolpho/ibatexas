/**
 * Session store tests — pure logic only, no DOM.
 *
 * Mocks fetch (for logout/hydrate), crypto (for session ID generation),
 * and @/lib/api (for getApiBase).
 *
 * NOTE: The session store has module-level side effects (initSession + hydrate
 * on first load when `globalThis.window` exists). We stub `globalThis.window`
 * to undefined before importing to prevent auto-initialization in tests.
 */

const mockGetApiBase = vi.hoisted(() => vi.fn(() => 'http://localhost:9000'))
const mockFetch = vi.hoisted(() => vi.fn())
const mockRandomUUID = vi.hoisted(() => vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'))

vi.mock('@/lib/api', () => ({
  getApiBase: mockGetApiBase,
}))

vi.mock('@ibatexas/tools/api', () => ({
  getApiBase: mockGetApiBase,
}))

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'

// Stub window to prevent module-level auto-init
const originalWindow = globalThis.window
beforeAll(() => {
  // @ts-expect-error — intentionally removing window for test isolation
  globalThis.window = undefined
})
afterAll(() => {
  globalThis.window = originalWindow
})

// Stub crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: mockRandomUUID,
  getRandomValues: (arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
    return arr
  },
})

vi.stubGlobal('fetch', mockFetch)

// Dynamic import to ensure mocks are in place before module executes
const { useSessionStore } = await import('../session.store')

// ── Setup ───────────────────────────────────────────────────────────────

function resetStore() {
  useSessionStore.setState({
    sessionId: '',
    customerId: undefined,
    channel: 'web',
    userType: 'guest',
    permissions: [],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})

// ── initSession ─────────────────────────────────────────────────────────

describe('initSession', () => {
  it('generates a new session ID when none exists', () => {
    mockRandomUUID.mockReturnValueOnce('11111111-2222-3333-4444-555555555555')
    useSessionStore.getState().initSession()

    expect(useSessionStore.getState().sessionId).toBe('11111111-2222-3333-4444-555555555555')
    expect(useSessionStore.getState().userType).toBe('guest')
    expect(useSessionStore.getState().customerId).toBeUndefined()
  })

  it('does not regenerate session ID if a valid UUID already exists', () => {
    useSessionStore.setState({ sessionId: 'aabbccdd-1122-3344-5566-778899aabbcc' })
    useSessionStore.getState().initSession()

    expect(useSessionStore.getState().sessionId).toBe('aabbccdd-1122-3344-5566-778899aabbcc')
    expect(mockRandomUUID).not.toHaveBeenCalled()
  })

  it('migrates legacy non-UUID session IDs', () => {
    useSessionStore.setState({ sessionId: 'legacy-session-id-not-uuid' })
    mockRandomUUID.mockReturnValueOnce('99999999-8888-7777-6666-555544443333')
    useSessionStore.getState().initSession()

    expect(useSessionStore.getState().sessionId).toBe('99999999-8888-7777-6666-555544443333')
  })

  it('migrates numeric session IDs (legacy)', () => {
    useSessionStore.setState({ sessionId: '12345' })
    mockRandomUUID.mockReturnValueOnce('aaaa0000-bbbb-cccc-dddd-eeee00001111')
    useSessionStore.getState().initSession()

    expect(useSessionStore.getState().sessionId).toBe('aaaa0000-bbbb-cccc-dddd-eeee00001111')
  })
})

// ── login ───────────────────────────────────────────────────────────────

describe('login', () => {
  it('sets customerId and userType to customer', () => {
    useSessionStore.getState().login('cust_abc')

    expect(useSessionStore.getState().customerId).toBe('cust_abc')
    expect(useSessionStore.getState().userType).toBe('customer')
  })

  it('overwrites previous customerId', () => {
    useSessionStore.setState({ customerId: 'old_cust', userType: 'customer' })
    useSessionStore.getState().login('new_cust')

    expect(useSessionStore.getState().customerId).toBe('new_cust')
  })

  it('does not affect session ID', () => {
    useSessionStore.setState({ sessionId: 'test-uuid-1234-5678-1234-567812345678' })
    useSessionStore.getState().login('cust_1')

    expect(useSessionStore.getState().sessionId).toBe('test-uuid-1234-5678-1234-567812345678')
  })
})

// ── setCustomer ─────────────────────────────────────────────────────────

describe('setCustomer', () => {
  it('sets customerId and userType to staff', () => {
    useSessionStore.getState().setCustomer('staff_1', 'staff')

    expect(useSessionStore.getState().customerId).toBe('staff_1')
    expect(useSessionStore.getState().userType).toBe('staff')
  })

  it('sets customerId and userType to customer', () => {
    useSessionStore.getState().setCustomer('cust_1', 'customer')

    expect(useSessionStore.getState().customerId).toBe('cust_1')
    expect(useSessionStore.getState().userType).toBe('customer')
  })
})

// ── logout ──────────────────────────────────────────────────────────────

describe('logout', () => {
  it('clears customerId, resets userType to guest, clears permissions', async () => {
    useSessionStore.setState({
      customerId: 'cust_1',
      userType: 'customer',
      permissions: ['admin'],
    })

    mockFetch.mockResolvedValueOnce({ ok: true })
    await useSessionStore.getState().logout()

    expect(useSessionStore.getState().customerId).toBeUndefined()
    expect(useSessionStore.getState().userType).toBe('guest')
    expect(useSessionStore.getState().permissions).toEqual([])
  })

  it('calls POST /api/auth/logout with credentials', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })
    await useSessionStore.getState().logout()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9000/api/auth/logout',
      { method: 'POST', credentials: 'include' },
    )
  })

  it('clears local state even when fetch fails', async () => {
    useSessionStore.setState({ customerId: 'cust_1', userType: 'customer' })
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    await useSessionStore.getState().logout()

    expect(useSessionStore.getState().customerId).toBeUndefined()
    expect(useSessionStore.getState().userType).toBe('guest')
  })

  it('preserves sessionId after logout', async () => {
    useSessionStore.setState({
      sessionId: '11111111-2222-3333-4444-555555555555',
      customerId: 'cust_1',
    })
    mockFetch.mockResolvedValueOnce({ ok: true })

    await useSessionStore.getState().logout()
    expect(useSessionStore.getState().sessionId).toBe('11111111-2222-3333-4444-555555555555')
  })
})

// ── hydrate ─────────────────────────────────────────────────────────────

describe('hydrate', () => {
  it('skips network call for guests (no customerId)', async () => {
    useSessionStore.setState({ customerId: undefined })
    await useSessionStore.getState().hydrate()

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches /api/auth/me for authenticated users', async () => {
    useSessionStore.setState({ customerId: 'cust_1' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cust_1', userType: 'customer' }),
    })

    await useSessionStore.getState().hydrate()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9000/api/auth/me',
      { credentials: 'include' },
    )
    expect(useSessionStore.getState().customerId).toBe('cust_1')
    expect(useSessionStore.getState().userType).toBe('customer')
  })

  it('promotes user to staff when API returns staff userType', async () => {
    useSessionStore.setState({ customerId: 'staff_1', userType: 'customer' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'staff_1', userType: 'staff' }),
    })

    await useSessionStore.getState().hydrate()
    expect(useSessionStore.getState().userType).toBe('staff')
  })

  it('defaults to customer when API omits userType', async () => {
    useSessionStore.setState({ customerId: 'cust_1' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cust_1' }),
    })

    await useSessionStore.getState().hydrate()
    expect(useSessionStore.getState().userType).toBe('customer')
  })

  it('clears auth state when API returns non-ok (expired cookie)', async () => {
    useSessionStore.setState({ customerId: 'cust_1', userType: 'customer' })
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    await useSessionStore.getState().hydrate()

    expect(useSessionStore.getState().customerId).toBeUndefined()
    expect(useSessionStore.getState().userType).toBe('guest')
  })

  it('leaves state unchanged on network error', async () => {
    useSessionStore.setState({ customerId: 'cust_1', userType: 'customer' })
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await useSessionStore.getState().hydrate()

    expect(useSessionStore.getState().customerId).toBe('cust_1')
    expect(useSessionStore.getState().userType).toBe('customer')
  })
})

// ── isAuthenticated ─────────────────────────────────────────────────────

describe('isAuthenticated', () => {
  it('returns false for guest (no customerId)', () => {
    expect(useSessionStore.getState().isAuthenticated()).toBe(false)
  })

  it('returns true when customerId is set', () => {
    useSessionStore.setState({ customerId: 'cust_1' })
    expect(useSessionStore.getState().isAuthenticated()).toBe(true)
  })

  it('returns false after logout', async () => {
    useSessionStore.setState({ customerId: 'cust_1' })
    mockFetch.mockResolvedValueOnce({ ok: true })
    await useSessionStore.getState().logout()
    expect(useSessionStore.getState().isAuthenticated()).toBe(false)
  })
})

// ── setChannel / setPermissions ─────────────────────────────────────────

describe('setChannel', () => {
  it('sets channel to whatsapp', () => {
    useSessionStore.getState().setChannel('whatsapp')
    expect(useSessionStore.getState().channel).toBe('whatsapp')
  })

  it('sets channel to web', () => {
    useSessionStore.setState({ channel: 'whatsapp' })
    useSessionStore.getState().setChannel('web')
    expect(useSessionStore.getState().channel).toBe('web')
  })
})

describe('setPermissions', () => {
  it('sets permissions array', () => {
    useSessionStore.getState().setPermissions(['admin', 'orders.view'])
    expect(useSessionStore.getState().permissions).toEqual(['admin', 'orders.view'])
  })

  it('replaces existing permissions', () => {
    useSessionStore.setState({ permissions: ['old'] })
    useSessionStore.getState().setPermissions(['new'])
    expect(useSessionStore.getState().permissions).toEqual(['new'])
  })

  it('can clear permissions with empty array', () => {
    useSessionStore.setState({ permissions: ['admin'] })
    useSessionStore.getState().setPermissions([])
    expect(useSessionStore.getState().permissions).toEqual([])
  })
})
