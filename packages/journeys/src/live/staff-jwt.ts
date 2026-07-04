// live/staff-jwt.ts — PURE staff-JWT claim builder + a thin signer for the
// WS9 ops live suite, run against a DEV stack.
//
// Distinct from clients/auth-fixture.ts on purpose:
//   • auth-fixture.ts mints for the EPHEMERAL TEST PROFILE and REFUSES
//     without IBX_TEST_FINGERPRINT (that gate is the test plane's trust
//     anchor — D-010).
//   • The WS9 live suite drives the DEV stack (which never carries the
//     fingerprint), so it needs a sibling minting path gated by NODE_ENV
//     instead. The CLAIM SHAPE is identical and cites the same source of
//     truth: issueStaffJwtToken (apps/api/src/routes/auth.ts:198-205) and
//     mintStaffToken (clients/auth-fixture.ts).
//
// This module is PURE + signing only (no env reads, no NODE_ENV guard, no
// prisma) so the claim shape is cheap to unit-test. The executable
// (live/mint-staff-jwt.ts) owns the dev-guard, the STAFF_JWT_SECRET env read,
// and the optional prisma phone lookup.

import { createSigner } from "fast-jwt"
import {
  STAFF_COOKIE_NAME,
  STAFF_ROLES,
  STAFF_TOKEN_TTL,
  type StaffRole,
} from "../clients/auth-fixture.js"

export { STAFF_COOKIE_NAME, STAFF_ROLES, STAFF_TOKEN_TTL, type StaffRole }

/** The exact claim shape issueStaffJwtToken signs (routes/auth.ts:199-203). */
export interface StaffJwtClaims {
  readonly sub: string
  readonly userType: "staff"
  readonly role: StaffRole
  readonly jti: string
  readonly aud: typeof STAFF_COOKIE_NAME
}

export interface BuildStaffJwtClaimsOptions {
  /** The staff id — becomes `sub`; MUST reference an ACTIVE ibx_domain.staff
   *  row (middleware/auth.ts:178-179 re-checks it on every request). */
  readonly staffId: string
  /** OWNER | MANAGER | ATTENDANT — must match the seeded row for honest turns. */
  readonly role: StaffRole
  /** Unique token id (revocation-list friendly); the executor passes a UUID. */
  readonly jti: string
}

/**
 * Build the staff JWT claim object (no signing). Fails fast on an empty `sub`
 * (middleware/auth.ts:the API silently treats an empty/whitespace `sub` as
 * unauthenticated) or an unknown role.
 */
export function buildStaffJwtClaims(
  opts: BuildStaffJwtClaimsOptions,
): StaffJwtClaims {
  if (opts.staffId.trim() === "") {
    throw new Error(
      "buildStaffJwtClaims: staffId (sub) must be non-empty — the API rejects empty/whitespace sub",
    )
  }
  if (!STAFF_ROLES.includes(opts.role)) {
    throw new Error(
      `buildStaffJwtClaims: role must be one of ${STAFF_ROLES.join(" | ")} (got "${String(opts.role)}")`,
    )
  }
  if (opts.jti.trim() === "") {
    throw new Error("buildStaffJwtClaims: jti must be non-empty")
  }
  return {
    sub: opts.staffId,
    userType: "staff",
    role: opts.role,
    jti: opts.jti,
    aud: STAFF_COOKIE_NAME,
  }
}

export interface SignStaffJwtOptions {
  /** The dev stack's STAFF_JWT_SECRET (HS256; MUST differ from JWT_SECRET). */
  readonly secret: string
  /** fast-jwt `expiresIn`; default the API's own 8h (STAFF_TOKEN_TTL). */
  readonly expiresIn?: number | string
}

/**
 * Sign staff claims into a compact HS256 JWS — byte-for-byte the way the API
 * signs (server.jwt.staff.sign over fast-jwt; a string key ⇒ HS256). `aud`
 * rides IN the payload exactly like issueStaffJwtToken puts it there, so the
 * staff instance's `allowedAud: "staff_token"` accepts it.
 */
export function signStaffJwt(
  claims: StaffJwtClaims,
  opts: SignStaffJwtOptions,
): string {
  if (opts.secret.trim() === "") {
    throw new Error(
      "signStaffJwt: secret must be non-empty (the dev stack's STAFF_JWT_SECRET)",
    )
  }
  const sign = createSigner({
    key: opts.secret,
    algorithm: "HS256",
    expiresIn: opts.expiresIn ?? STAFF_TOKEN_TTL,
  })
  return sign({ ...claims })
}

/** `staff_token=<jws>` — the single Cookie-header pair the API reads staff auth from. */
export function staffCookie(token: string): string {
  return `${STAFF_COOKIE_NAME}=${token}`
}
