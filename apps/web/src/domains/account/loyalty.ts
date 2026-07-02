/**
 * Loyalty balance (CUS-067, web view). Read-only fetch of the authenticated
 * customer's punch-card stamp balance for the account page — the web sibling of
 * the WhatsApp `fidelidade` shortcut.
 */

import { apiFetch } from '@/lib/api'

export interface LoyaltyBalance {
  readonly stamps: number
  readonly stampsNeeded: number
  readonly totalEarned: number
}

/** Fetch the current customer's stamp balance (GET /api/me/loyalty). */
export async function fetchLoyaltyBalance(): Promise<LoyaltyBalance> {
  return apiFetch<LoyaltyBalance>('/api/me/loyalty', { credentials: 'include' })
}

/** Stamps required for a reward (mirrors the domain's STAMPS_FOR_REWARD = 10). */
export const STAMPS_FOR_REWARD = 10
