// T1a-4 offline tests — minted claim shape, the fingerprint containment gate,
// wrong-secret rejection, jti uniqueness, cookie assembly. Fully offline:
// mirror-verification uses fast-jwt's createVerifier configured EXACTLY like
// the API's two @fastify/jwt instances (apps/api/src/server.ts:70-75 customer
// `allowedAud: "token"`; :89-93 staff `allowedAud: "staff_token"`) — same
// library family the API signs with, so a token that passes here passes the
// API's crypto layer.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createVerifier } from "fast-jwt"
import {
  mintCustomerToken,
  mintStaffToken,
  cookieHeader,
  TestFingerprintRequiredError,
  AuthFixtureOptionError,
  CUSTOMER_COOKIE_NAME,
  STAFF_COOKIE_NAME,
} from "../auth-fixture.js"

// ≥32-char distinct secrets, mirroring the .env.test contract (48 hex chars
// from gen-env-test.sh). Never real values.
const JWT_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"
const STAFF_JWT_SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210"
const WRONG_SECRET = "aaaabbbbccccddddeeeeffff0000111122223333aaaabbbb"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Claims = {
  sub: string
  userType: string
  jti: string
  aud: string
  role?: string
  iat: number
  exp: number
}

// Mirror of the API's customer verifier (server.ts:70-75).
const verifyAsCustomerInstance = createVerifier({
  key: JWT_SECRET,
  allowedAud: "token",
})
// Mirror of the API's namespaced staff verifier (server.ts:89-93).
const verifyAsStaffInstance = createVerifier({
  key: STAFF_JWT_SECRET,
  allowedAud: "staff_token",
})

beforeEach(() => {
  vi.stubEnv("IBX_TEST_FINGERPRINT", "ibx-test-0123456789abcdef")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("mintCustomerToken — claim shape (routes/auth.ts:178-182)", () => {
  it("mints {sub, userType:'customer', jti, aud:'token'} verifiable by the customer-instance mirror", () => {
    const minted = mintCustomerToken({ customerId: "cus_journey_1", jwtSecret: JWT_SECRET })
    const claims = verifyAsCustomerInstance(minted.token) as Claims

    expect(claims.sub).toBe("cus_journey_1")
    expect(claims.userType).toBe("customer")
    expect(claims.aud).toBe("token")
    expect(claims.jti).toMatch(UUID_RE)
    expect(claims.jti).toBe(minted.jti)
    // expiresIn '4h' (routes/auth.ts:182)
    expect(claims.exp - claims.iat).toBe(4 * 3600)
  })

  it("accepts `sub` as an alias of `customerId`", () => {
    const minted = mintCustomerToken({ sub: "cus_alias", jwtSecret: JWT_SECRET })
    expect((verifyAsCustomerInstance(minted.token) as Claims).sub).toBe("cus_alias")
  })

  it("rejects disagreeing customerId/sub, missing sub, and whitespace sub (middleware/auth.ts:116-118 mirror)", () => {
    expect(() =>
      mintCustomerToken({ customerId: "a", sub: "b", jwtSecret: JWT_SECRET }),
    ).toThrow(AuthFixtureOptionError)
    expect(() => mintCustomerToken({ jwtSecret: JWT_SECRET })).toThrow(AuthFixtureOptionError)
    expect(() => mintCustomerToken({ customerId: "   ", jwtSecret: JWT_SECRET })).toThrow(
      AuthFixtureOptionError,
    )
    expect(() => mintCustomerToken({ customerId: "x", jwtSecret: "" })).toThrow(
      AuthFixtureOptionError,
    )
  })

  it("delivers as the `token=` cookie (the API has no customer header path)", () => {
    const minted = mintCustomerToken({ customerId: "cus_c", jwtSecret: JWT_SECRET })
    expect(minted.cookieName).toBe(CUSTOMER_COOKIE_NAME)
    expect(minted.cookie).toBe(`token=${minted.token}`)
  })

  it("mints a UNIQUE jti per call", () => {
    const a = mintCustomerToken({ customerId: "cus_j", jwtSecret: JWT_SECRET })
    const b = mintCustomerToken({ customerId: "cus_j", jwtSecret: JWT_SECRET })
    expect(a.jti).not.toBe(b.jti)
  })
})

describe("mintStaffToken — claim shape (routes/auth.ts:199-204)", () => {
  it("mints {sub, userType:'staff', role, jti, aud:'staff_token'} verifiable by the staff-instance mirror", () => {
    const minted = mintStaffToken({
      staffId: "stf_journey_1",
      role: "MANAGER",
      staffJwtSecret: STAFF_JWT_SECRET,
    })
    const claims = verifyAsStaffInstance(minted.token) as Claims

    expect(claims.sub).toBe("stf_journey_1")
    expect(claims.userType).toBe("staff")
    expect(claims.role).toBe("MANAGER")
    expect(claims.aud).toBe("staff_token")
    expect(claims.jti).toMatch(UUID_RE)
    // expiresIn '8h' (routes/auth.ts:204)
    expect(claims.exp - claims.iat).toBe(8 * 3600)
  })

  it("delivers as the `staff_token=` cookie (middleware/auth.ts:140 — strictly cookie)", () => {
    const minted = mintStaffToken({
      staffId: "stf_c",
      role: "OWNER",
      staffJwtSecret: STAFF_JWT_SECRET,
    })
    expect(minted.cookieName).toBe(STAFF_COOKIE_NAME)
    expect(minted.cookie).toBe(`staff_token=${minted.token}`)
  })

  it("rejects an unknown role", () => {
    expect(() =>
      mintStaffToken({
        staffId: "stf_r",
        // @ts-expect-error — role union is the contract; runtime gate for JS callers
        role: "SUPERUSER",
        staffJwtSecret: STAFF_JWT_SECRET,
      }),
    ).toThrow(AuthFixtureOptionError)
  })
})

describe("containment — the fingerprint gate (governance-critical)", () => {
  it("refuses to mint when IBX_TEST_FINGERPRINT is unset", () => {
    vi.unstubAllEnvs()
    const prev = process.env["IBX_TEST_FINGERPRINT"]
    delete process.env["IBX_TEST_FINGERPRINT"]
    try {
      expect(() => mintCustomerToken({ customerId: "cus_x", jwtSecret: JWT_SECRET })).toThrow(
        TestFingerprintRequiredError,
      )
      expect(() =>
        mintStaffToken({ staffId: "stf_x", role: "OWNER", staffJwtSecret: STAFF_JWT_SECRET }),
      ).toThrow(TestFingerprintRequiredError)
    } finally {
      if (prev !== undefined) process.env["IBX_TEST_FINGERPRINT"] = prev
    }
  })

  it("treats an empty/whitespace fingerprint as unset", () => {
    vi.stubEnv("IBX_TEST_FINGERPRINT", "   ")
    expect(() => mintCustomerToken({ customerId: "cus_x", jwtSecret: JWT_SECRET })).toThrow(
      TestFingerprintRequiredError,
    )
  })

  it("the refusal is a NAMED error (machine-checkable)", () => {
    vi.stubEnv("IBX_TEST_FINGERPRINT", "")
    try {
      mintCustomerToken({ customerId: "cus_x", jwtSecret: JWT_SECRET })
      expect.fail("mintCustomerToken should have refused")
    } catch (err) {
      expect((err as Error).name).toBe("TestFingerprintRequiredError")
    }
  })
})

describe("secret distinctness — wrong-secret verification fails (mirror-verify)", () => {
  it("a customer token does NOT verify under any other secret", () => {
    const minted = mintCustomerToken({ customerId: "cus_w", jwtSecret: JWT_SECRET })
    expect(() => createVerifier({ key: WRONG_SECRET })(minted.token)).toThrow()
    // Cross-tier: the staff instance (different secret) rejects it at the
    // crypto layer — exactly the JWTSPLIT property (server.ts:83-88).
    expect(() => verifyAsStaffInstance(minted.token)).toThrow()
  })

  it("a staff token does NOT verify under the customer secret", () => {
    const minted = mintStaffToken({
      staffId: "stf_w",
      role: "ATTENDANT",
      staffJwtSecret: STAFF_JWT_SECRET,
    })
    expect(() => createVerifier({ key: JWT_SECRET })(minted.token)).toThrow()
    expect(() => verifyAsCustomerInstance(minted.token)).toThrow()
  })

  it("aud binding: a customer token fails a verifier expecting aud 'staff_token' even under the right key", () => {
    const minted = mintCustomerToken({ customerId: "cus_aud", jwtSecret: JWT_SECRET })
    expect(() =>
      createVerifier({ key: JWT_SECRET, allowedAud: "staff_token" })(minted.token),
    ).toThrow()
  })
})

describe("cookieHeader — Cookie assembly for fetch/SSE (shared with ChatClient)", () => {
  it("assembles a single pair and a combined customer+staff header", () => {
    const customer = mintCustomerToken({ customerId: "cus_h", jwtSecret: JWT_SECRET })
    const staff = mintStaffToken({
      staffId: "stf_h",
      role: "MANAGER",
      staffJwtSecret: STAFF_JWT_SECRET,
    })
    expect(cookieHeader(customer)).toBe(`token=${customer.token}`)
    expect(cookieHeader(customer, staff)).toBe(
      `token=${customer.token}; staff_token=${staff.token}`,
    )
  })

  it("refuses duplicates of the same cookie name and an empty call", () => {
    const a = mintCustomerToken({ customerId: "cus_d1", jwtSecret: JWT_SECRET })
    const b = mintCustomerToken({ customerId: "cus_d2", jwtSecret: JWT_SECRET })
    expect(() => cookieHeader(a, b)).toThrow(AuthFixtureOptionError)
    expect(() => cookieHeader()).toThrow(AuthFixtureOptionError)
  })
})
