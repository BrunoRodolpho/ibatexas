/**
 * LGPD account deletion (CUS-065, web view) — the client half of the fully-built
 * server flow (me.ts): send-otp → verify-otp (60s window) → initiate-deletion
 * (kernel DEFER, 24h grace) → cancel-deletion. Each call is a thin governed POST;
 * the server enforces OTP freshness, brute-force lockout, and the grace window.
 */

import { apiFetch } from '@/lib/api'

/** The four ordered steps of the deletion flow the UI walks through. */
export type DeletionStep = 'idle' | 'otp_sent' | 'verified' | 'scheduled'

/** A 6-digit numeric OTP — gates the verify button so we don't POST garbage. */
export function isValidOtp(token: string): boolean {
  return /^\d{6}$/.test(token.trim())
}

/** Step 1 — emit a fresh OTP (Twilio Verify). 202 on success. */
export async function requestDeletionOtp(): Promise<void> {
  await apiFetch('/api/me/data/send-otp', { method: 'POST', credentials: 'include' })
}

/** Step 2 — verify the code, opening the 60s "verified" window. Throws on a bad code. */
export async function verifyDeletionOtp(token: string): Promise<void> {
  await apiFetch('/api/me/data/verify-otp', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({ token: token.trim() }),
  })
}

/** Step 3 — park the deletion as a 24h-grace DEFER. 202 on success. */
export async function initiateAccountDeletion(): Promise<void> {
  await apiFetch('/api/me/data/initiate-deletion', { method: 'POST', credentials: 'include' })
}

/** Step 4 — abort a scheduled deletion within the grace window. */
export async function cancelAccountDeletion(): Promise<void> {
  await apiFetch('/api/me/data/cancel-deletion', { method: 'POST', credentials: 'include' })
}
