// Signed session claims for zero-trust session verification.
// Uses HMAC-SHA256 to sign {sessionId, customerId, issuedAt} tuples.
// Consumers verify the signature before trusting session ownership.

import { createHmac, timingSafeEqual } from "node:crypto"

const SECRET = process.env.SESSION_HMAC_SECRET ?? "dev-session-secret-change-me"
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h

export interface SessionClaim {
  sessionId: string
  customerId: string
  issuedAt: number // epoch ms
}

/**
 * Sign a session claim → returns a base64url HMAC signature.
 */
export function signSessionClaim(claim: SessionClaim): string {
  const payload = `${claim.sessionId}:${claim.customerId}:${claim.issuedAt}`
  return createHmac("sha256", SECRET).update(payload).digest("base64url")
}

/**
 * Create a signed session token string: `sessionId.customerId.issuedAt.signature`
 */
export function createSessionToken(sessionId: string, customerId: string): string {
  const claim: SessionClaim = { sessionId, customerId, issuedAt: Date.now() }
  const sig = signSessionClaim(claim)
  return `${claim.sessionId}.${claim.customerId}.${claim.issuedAt}.${sig}`
}

/**
 * Parse and verify a session token string.
 * Returns the claim if valid, null if tampered/expired.
 */
export function verifySessionToken(token: string): SessionClaim | null {
  const parts = token.split(".")
  if (parts.length !== 4) return null

  const [sessionId, customerId, issuedAtStr, signature] = parts
  const issuedAt = Number.parseInt(issuedAtStr!, 10)
  if (Number.isNaN(issuedAt)) return null

  // Check expiry
  if (Date.now() - issuedAt > MAX_AGE_MS) return null

  // Recompute and compare signatures (timing-safe)
  const claim: SessionClaim = { sessionId: sessionId!, customerId: customerId!, issuedAt }
  const expected = signSessionClaim(claim)

  const sigBuf = Buffer.from(signature!, "base64url")
  const expBuf = Buffer.from(expected, "base64url")
  if (sigBuf.length !== expBuf.length) return null
  if (!timingSafeEqual(sigBuf, expBuf)) return null

  return claim
}
