/**
 * Saved addresses (CUS-063, web view). Thin client over the governed
 * /api/me/addresses routes (add/remove adjudicated via customer.address.*;
 * removal is ownership-scoped server-side). Field names mirror the pt-BR form:
 * neighborhood + zip map to the server's district + cep.
 */

import { apiFetch } from '@/lib/api'

export interface SavedAddress {
  readonly id: string
  readonly street: string
  readonly number: string
  readonly complement: string | null
  readonly district: string
  readonly city: string
  readonly state: string
  readonly cep: string
  readonly isDefault: boolean
}

export interface NewAddress {
  readonly street: string
  readonly number?: string
  readonly complement?: string
  readonly neighborhood?: string
  readonly city: string
  readonly state: string
  readonly zip: string
  readonly isDefault?: boolean
}

/** BR CEP: 8 digits, optionally hyphenated (12345-678). */
export function isValidCep(cep: string): boolean {
  return /^\d{5}-?\d{3}$/.test(cep.trim())
}

/** BR state: two letters. */
export function isValidState(state: string): boolean {
  return /^[A-Za-z]{2}$/.test(state.trim())
}

/** True when the required fields are present + CEP/state well-formed (gates submit). */
export function isCompleteAddress(a: NewAddress): boolean {
  return (
    a.street.trim() !== '' &&
    a.city.trim() !== '' &&
    isValidState(a.state) &&
    isValidCep(a.zip)
  )
}

/** List the customer's saved addresses. Returns [] on a read error. */
export async function listAddresses(): Promise<SavedAddress[]> {
  try {
    const data = await apiFetch<{ addresses?: SavedAddress[] }>('/api/me/addresses', {
      credentials: 'include',
    })
    return data.addresses ?? []
  } catch {
    return []
  }
}

/** Add an address through the governed route; returns the created row. */
export async function addAddress(input: NewAddress): Promise<SavedAddress> {
  const data = await apiFetch<{ address: SavedAddress }>('/api/me/addresses', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({
      street: input.street.trim(),
      city: input.city.trim(),
      state: input.state.trim().toUpperCase(),
      zip: input.zip.trim(),
      ...(input.number?.trim() ? { number: input.number.trim() } : {}),
      ...(input.complement?.trim() ? { complement: input.complement.trim() } : {}),
      ...(input.neighborhood?.trim() ? { neighborhood: input.neighborhood.trim() } : {}),
      ...(input.isDefault ? { isDefault: true } : {}),
    }),
  })
  return data.address
}

/** Remove a saved address by id (ownership enforced server-side). */
export async function removeAddress(addressId: string): Promise<void> {
  await apiFetch(`/api/me/addresses/${encodeURIComponent(addressId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
}
