// Auth middleware for Fastify.
// Extracts the JWT from the `token` httpOnly cookie (customers/guests) or the
// `staff_token` httpOnly cookie (staff) and attaches request.customerId /
// request.staffId + request.userType so route handlers can access them.
//
// Usage:
//   requireAuth  — throws 401 if no valid JWT
//   optionalAuth — attaches fields if JWT present, no-op otherwise

import type { FastifyRequest, FastifyReply } from "fastify";
import { getRedisClient, rk } from "@ibatexas/tools";
import { createStaffService } from "@ibatexas/domain";
import {
  classifyStaffLookupError,
  isStaffAuthInfraError,
  reportStaffAuthInfraError,
} from "./staff-auth-infra-alert.js";

// Extend Fastify's request type with our custom fields
declare module "fastify" {
  interface FastifyRequest {
    customerId?: string;
    userType?: "guest" | "customer" | "staff";
    /** DOM-001: Staff-specific fields (set when userType === "staff") */
    staffId?: string;
    staffRole?: "OWNER" | "MANAGER" | "ATTENDANT";
  }
}

type DoneCallback = (err?: Error) => void

class RedisUnavailableError extends Error {
  constructor() {
    super("Redis revocation check unavailable");
    this.name = "RedisUnavailableError";
  }
}

type JwtPayload = {
  sub: string;
  userType: string;
  jti?: string;
  role?: string;
  /**
   * Cookie-name binding (audit-2026-05-25): customer JWTs are issued with
   * `aud: "token"`, staff JWTs with `aud: "staff_token"`. Verification
   * rejects any token whose `aud` does not match the cookie it arrived in.
   * Prevents the escalation path the multi-agent review flagged where a
   * staff JWT placed in the customer `token` cookie would mint a staff
   * principal through the customer path. Older tokens issued before this
   * change carry `aud === undefined`; we treat undefined as "legacy,
   * accept" so the deploy doesn't 401 every signed-in user — adopters
   * will rotate to `aud`-bearing tokens within the standard TTL (4h
   * customer / 8h staff).
   */
  aud?: string;
};

/**
 * Expected `aud` claim per cookie source. Tokens issued before the
 * aud-binding deploy carry `aud === undefined`; the validator treats
 * undefined as "legacy, accept" during the rollover window so existing
 * signed-in sessions don't all 401 at once. After the longest staff JWT
 * TTL (8h) has elapsed post-deploy, the legacy-accept can be tightened
 * to fail-closed (drop the `=== undefined` branch).
 */
const COOKIE_TO_EXPECTED_AUD: Readonly<Record<string, string>> = {
  token: "token",
  staff_token: "staff_token",
} as const;

async function checkRevocation(jti: string | undefined): Promise<void> {
  if (!jti) return;
  try {
    const redis = await getRedisClient();
    const revoked = await redis.get(rk(`jwt:revoked:${jti}`));
    if (revoked) throw new Error("token revoked");
  } catch (err) {
    if ((err as Error).message === "token revoked") throw err;
    // SEC: Fail closed — if Redis is unreachable, reject the request
    // to prevent revoked tokens from being accepted
    throw new RedisUnavailableError();
  }
}

// ── Staff path: staff JWT lives in `staff_token` (separate from customer cookie) ──
// Extracted from extractAuth to keep that function's cognitive complexity low.
async function extractStaffAuth(request: FastifyRequest): Promise<void> {
  const staffTokenRaw = request.cookies?.["staff_token"];
  if (!staffTokenRaw) return;

  try {
    // JWTSPLIT (audit): verify the staff token with the DEDICATED staff instance
    // (separate secret + audience at server.jwt.staff). A customer token presented
    // in the staff_token cookie now fails at the crypto/audience layer (separate
    // secret) BEFORE the app-level userType/aud checks below — fail-closed earlier,
    // same outcome.
    const staffJwt = (request as unknown as { server: { jwt: { staff: { verify: (token: string) => JwtPayload } } } }).server.jwt.staff;
    const payload = staffJwt.verify(staffTokenRaw);

    if (payload.userType !== "staff") return; // Unexpected — not a staff token

    // NEW-P0-X8 + audit-2026-05-24 P1-6: same defense-in-depth for the
    // staff path. Reject empty- or whitespace-only `sub`.
    if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
      return;
    }

    // audit-2026-05-25 (I2): aud claim binding for staff_token. Legacy
    // tokens with undefined aud are accepted during rollover.
    if (
      payload.aud !== undefined &&
      payload.aud !== COOKIE_TO_EXPECTED_AUD.staff_token
    ) {
      return;
    }

    // SEC-004: Check revocation for staff token too
    await checkRevocation(payload.jti);

    // STAFFREVOKE: re-check the staff member is still active on every request.
    // Deactivation is a DB change (admin panel / seed) with NO token-revocation
    // event, so otherwise a deactivated staff's staff_token would keep working
    // until its expiry. Staff traffic is admin-panel volume (not the customer
    // hot path), so this per-request PK lookup is negligible.
    //
    // BKL-092: wrap ONLY this lookup so a DB failure is CLASSIFIED distinctly
    // from a JWT/revocation error. A genuine "record not found" (P2025 — the
    // deleted/deactivated staff this check exists to reject) fails closed
    // SILENTLY as before. A DB INFRASTRUCTURE error (schema drift P2022 /
    // connectivity P1xxx / any other DB error) fails closed IDENTICALLY (same
    // 401, no staff identity attached) but becomes SIGNAL — a structured ERROR
    // log + a repeat-counted ops-alert — instead of being swallowed as
    // unknown-staff. This is purely observability; authz behavior is unchanged.
    let staff: Awaited<ReturnType<ReturnType<typeof createStaffService>["getById"]>>;
    try {
      staff = await createStaffService().getById(payload.sub);
    } catch (dbErr) {
      const classification = classifyStaffLookupError(dbErr);
      if (isStaffAuthInfraError(classification)) {
        // Best-effort SIGNAL — never throws, never changes the fail-closed outcome.
        await reportStaffAuthInfraError(dbErr, classification, request.log);
      }
      return; // fail closed — unauthenticated (byte-identical to today's 401)
    }
    if (!staff.active) return; // deactivated → do not attach staff identity

    request.userType = "staff";
    request.staffId = payload.sub;
    // AUT-007 (adversarial-review FIX 1): source the role from the FRESH staff
    // row, never from the JWT claim baked at login. The row is already fetched
    // unconditionally above (STAFFREVOKE), which is exactly why deactivation is
    // live-enforced — but the role previously came from `payload.role`, so a
    // `staff.role.assign` demotion was a no-op for up to the 8h token TTL: a
    // demoted OWNER kept OWNER power (and could re-promote themselves or
    // deactivate the demoter). Role changes are now live-enforced symmetrically
    // with deactivation; the JWT claim is only login-time provenance.
    request.staffRole = staff.role;
  } catch (err) {
    if (err instanceof RedisUnavailableError) throw err;
    // Invalid staff_token — treat as unauthenticated
  }
}

async function extractAuth(request: FastifyRequest): Promise<void> {
  // ── Customer / guest path: fastifyJwt reads the `token` httpOnly cookie ──
  try {
    await (request as unknown as { jwtVerify: () => Promise<void> }).jwtVerify();
    const payload = (request as unknown as { user: JwtPayload }).user;

    // audit-2026-05-25 (post-review I2): reject staff tokens arriving on
    // the customer cookie path. Pre-fix, a JWT with `userType: "staff"`
    // placed in the `token` cookie would have been minted as a staff
    // principal (lines below set request.staffId/staffRole from the
    // payload). Combined with the admin preHandler at routes/admin/index.ts
    // admitting on `staffId && staffRole`, that produced a full
    // privilege-escalation path through cookie mixing. Defense-in-depth:
    // the customer path ONLY handles guest/customer tokens; staff tokens
    // must arrive through the `staff_token` cookie or be rejected outright.
    if (payload.userType === "staff") {
      return;
    }

    // SEC-004: Check if the token has been revoked (e.g., after logout)
    await checkRevocation(payload.jti);

    // NEW-P0-X8 (W1 correctness remediation): reject empty-string `sub`.
    // An empty `sub` would otherwise be assigned to `customerId`/`staffId`,
    // collapsing every empty-`sub` JWT onto the same Redis key namespace
    // (`anonymize:otp:`, `defer:pending:`, …). The downstream
    // `requireAuth` gate currently catches `!customerId` (since `!""` is
    // truthy), but defense-in-depth: never assign empty `sub`.
    //
    // audit-2026-05-24 P1-6: also reject whitespace-only `sub`. W7-G1
    // patched the OTP gate via `normalizeSub`, but the middleware itself
    // still accepted `"   "` — those tokens would have populated
    // `customerId` with whitespace and then collided on shared Redis
    // keys (defer:pending:, otp:fail:…) the same way the empty string
    // does.
    if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
      return;
    }

    // audit-2026-05-25 (I2): aud claim binding. New customer JWTs carry
    // `aud: "token"`; legacy tokens (issued before the rollover) carry
    // `aud === undefined` and are accepted during the TTL window.
    if (
      payload.aud !== undefined &&
      payload.aud !== COOKIE_TO_EXPECTED_AUD.token
    ) {
      return;
    }

    request.userType = payload.userType as "guest" | "customer" | "staff";
    request.customerId = payload.sub;
    return;
  } catch (err) {
    // SEC: Redis failure must propagate — do not silently accept potentially revoked tokens
    if (err instanceof RedisUnavailableError) throw err;
    // Invalid or missing `token` cookie — fall through to staff_token check
  }

  // ── Staff path: handled in a dedicated helper to keep complexity bounded ──
  await extractStaffAuth(request);
}

/**
 * preHandler: requires a valid JWT cookie.
 * Returns 401 if missing or invalid.
 *
 * Uses callback style to satisfy Fastify's preHandler type (S6544).
 */
export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  done: DoneCallback,
): void {
  // Return before done() on 401 to prevent route handler from executing
  extractAuth(request).then(() => {
    // NEW-P0-X8 + audit-2026-05-24 P1-6: explicit empty/whitespace check
    // (defense in depth). `!""` is truthy so the original
    // `!request.customerId` already catches the empty string, but a
    // whitespace-only `sub` like `"   "` is truthy AND collides on
    // shared Redis keys. Spell out both invariants so future refactors
    // can't drop them.
    if (
      !request.customerId ||
      request.customerId.trim().length === 0
    ) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Sessão inválida." });
      return;
    }
    done();
  }, (err) => {
    if (err instanceof RedisUnavailableError) {
      void reply
        .code(503)
        .send({ error: "Service temporarily unavailable" });
      return;
    }
    done(err);
  });
}

/**
 * preHandler: attaches auth fields if a valid JWT cookie is present.
 * Does nothing if the cookie is absent or invalid.
 *
 * Uses callback style to satisfy Fastify's preHandler type (S6544).
 */
export function optionalAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  done: DoneCallback,
): void {
  extractAuth(request).then(() => done(), (err) => {
    if (err instanceof RedisUnavailableError) {
      void reply
        .code(503)
        .send({ error: "Service temporarily unavailable" });
      return;
    }
    done(err);
  });
}
