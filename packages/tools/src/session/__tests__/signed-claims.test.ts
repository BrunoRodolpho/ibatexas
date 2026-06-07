// Tests for signed session claims (P1-CRYPTO-SESSIONKEY).
// The HMAC key must be loaded from env and fail closed in prod — never fall
// back to a source-committed literal that would let anyone forge claims.

import { describe, it, expect, vi, afterEach } from "vitest"
import { createHmac } from "node:crypto"
import { signSessionClaim, createSessionToken, verifySessionToken } from "../signed-claims.js"

const REAL_SECRET = "a-real-session-secret-at-least-32-chars-long-xxxx"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("session secret loading", () => {
  it("throws in prod when SESSION_HMAC_SECRET is missing (no public-key fallback)", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SESSION_HMAC_SECRET", "")
    expect(() => createSessionToken("sess-1", "cust-1")).toThrow(/SESSION_HMAC_SECRET env var is required/)
  })

  it("throws when set to the known .env.example placeholder", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SESSION_HMAC_SECRET", "change-me-in-production")
    expect(() => createSessionToken("sess-1", "cust-1")).toThrow(/placeholder/)
  })

  it("rejects the legacy hardcoded literal as a placeholder", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SESSION_HMAC_SECRET", "dev-session-secret-change-me")
    expect(() => signSessionClaim({ sessionId: "s", customerId: "c", issuedAt: Date.now() })).toThrow(/placeholder/)
  })

  it("throws when the secret is too short", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SESSION_HMAC_SECRET", "too-short")
    expect(() => createSessionToken("sess-1", "cust-1")).toThrow(/at least 32 characters/)
  })

  it("signs and verifies a round-trip with a real secret", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SESSION_HMAC_SECRET", REAL_SECRET)

    const token = createSessionToken("sess-9", "cust-9")
    const claim = verifySessionToken(token)
    expect(claim).not.toBeNull()
    expect(claim?.sessionId).toBe("sess-9")
    expect(claim?.customerId).toBe("cust-9")
  })

  it("rejects a token forged under the old hardcoded literal", () => {
    // An attacker signs with the public literal; the server (real secret) must reject it.
    const issuedAt = Date.now()
    const payload = `sess-x:cust-x:${issuedAt}`
    const forgedSig = createHmac("sha256", "dev-session-secret-change-me").update(payload).digest("base64url")
    const forgedToken = `sess-x.cust-x.${issuedAt}.${forgedSig}`

    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SESSION_HMAC_SECRET", REAL_SECRET)
    expect(verifySessionToken(forgedToken)).toBeNull()
  })
})
