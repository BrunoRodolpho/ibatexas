// Signed session claims for zero-trust session verification.
// Uses HMAC-SHA256 to sign {sessionId, customerId, issuedAt} tuples.
// Consumers verify the signature before trusting session ownership.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h

// Known .env.example placeholders that must never be accepted as a real secret —
// signing with a publicly-known key lets anyone forge session claims.
const REJECTED_SECRETS = new Set(["change-me-in-production", "dev-session-secret-change-me"])

/**
 * Load SESSION_HMAC_SECRET, failing closed.
 *
 * - prod/dev: throws if missing, too short, or a known placeholder.
 * - test: returns a stable per-process random secret when unset, so tests can
 *   sign+verify round-trips without a configured value. An explicitly-set value
 *   (including a placeholder) is still validated, so the fail-closed behavior is
 *   itself testable.
 *
 * Resolved lazily (per call, not at import) so the module can be imported in
 * environments that configure the secret after load.
 */
let _testFallbackSecret: string | undefined
function sessionSecret(): string {
  const value = process.env.SESSION_HMAC_SECRET

  if (process.env.NODE_ENV === "test" && (value === undefined || value === "")) {
    _testFallbackSecret ??= randomBytes(32).toString("base64")
    return _testFallbackSecret
  }

  if (!value) {
    throw new Error("SESSION_HMAC_SECRET env var is required")
  }
  if (REJECTED_SECRETS.has(value)) {
    throw new Error("SESSION_HMAC_SECRET is set to a known placeholder — generate a real secret (openssl rand -base64 32)")
  }
  if (value.length < 32) {
    throw new Error("SESSION_HMAC_SECRET must be at least 32 characters")
  }
  return value
}

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
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url")
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
