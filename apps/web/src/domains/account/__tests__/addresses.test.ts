/**
 * Saved addresses (CUS-063 web view). Validators gate the submit; the fetch
 * helpers map the pt-BR form fields onto the governed route body and default
 * safely on read errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ apiFetch: mockApiFetch }))

import {
  isValidCep,
  isValidState,
  isCompleteAddress,
  listAddresses,
  addAddress,
  removeAddress,
} from '../addresses'

describe('addresses — validators (CUS-063)', () => {
  it('isValidCep accepts 8 digits with/without hyphen', () => {
    expect(isValidCep('01001000')).toBe(true)
    expect(isValidCep('01001-000')).toBe(true)
    expect(isValidCep('123')).toBe(false)
    expect(isValidCep('')).toBe(false)
  })
  it('isValidState accepts two letters only', () => {
    expect(isValidState('SP')).toBe(true)
    expect(isValidState('sp')).toBe(true)
    expect(isValidState('S')).toBe(false)
    expect(isValidState('SPO')).toBe(false)
  })
  it('isCompleteAddress requires street+city+valid state+valid cep', () => {
    expect(isCompleteAddress({ street: 'Rua A', city: 'SP', state: 'SP', zip: '01001-000' })).toBe(true)
    expect(isCompleteAddress({ street: '', city: 'SP', state: 'SP', zip: '01001-000' })).toBe(false)
    expect(isCompleteAddress({ street: 'Rua A', city: 'SP', state: 'SP', zip: '1' })).toBe(false)
  })
})

describe('addresses — fetch helpers (CUS-063)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('listAddresses returns the rows and [] on error', async () => {
    mockApiFetch.mockResolvedValue({ addresses: [{ id: 'a1' }] })
    expect(await listAddresses()).toEqual([{ id: 'a1' }])
    mockApiFetch.mockRejectedValue(new Error('500'))
    expect(await listAddresses()).toEqual([])
  })

  it('addAddress sends trimmed, mapped, non-empty fields', async () => {
    mockApiFetch.mockResolvedValue({ address: { id: 'a1' } })
    await addAddress({ street: ' Rua A ', number: '', neighborhood: ' Centro ', city: 'São Paulo', state: 'sp', zip: '01001-000', isDefault: true })
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/addresses',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          street: 'Rua A',
          city: 'São Paulo',
          state: 'SP',
          zip: '01001-000',
          neighborhood: 'Centro',
          isDefault: true,
        }),
      }),
    )
  })

  it('removeAddress DELETEs the encoded id', async () => {
    mockApiFetch.mockResolvedValue({ success: true })
    await removeAddress('addr 1')
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/me/addresses/addr%201',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
