// anonymize-otp-gate.ts — LGPD-anonymize OTP freshness gate.
//
// ── Task 14 (M3) — LGPD anonymize multi-endpoint flow ─────────────────────
//
// The LGPD anonymize path is the most destructive customer-driven
// operation we expose (per investigation 08 P0 #2: "one-click
// destructive, unconfirmed, unadjudicated").
//
// ── W4 P0-11 hardening (stolen-JWT defense + OTP brute-force counter) ────
//
// Pre-W4 a stolen JWT alone authorised initiate-deletion (the route
// SMSed a code to the legitimate customer's phone, then DELETE
// verified that code — no app-layer brute-force counter, no cooldown
// after cancel). Per audit 05 §"A1/A2/A3" this enabled:
//   - Stolen-JWT one-shot account destruction (no fresh-OTP gate at
//     initiation).
//   - Brute-force across many initiate-deletions: each emits a fresh
//     6-digit code; Twilio's 5-strike-per-code limit resets per code.
//   - Cancel-then-reinitiate amplifies victim harassment + Twilio
//     spend; no cooldown.
//
// The W4 flow is:
//   1. POST /api/me/data/send-otp           — emit a fresh OTP via
//      Twilio Verify. Records `anonymize:otp:{customerId}` (5min TTL)
//      so verify-otp can fast-fail past the TTL.
//   2. POST /api/me/data/verify-otp         — verify the code via
//      Twilio Verify. Sets `anonymize:otp_verified:{customerId}` (60s
//      TTL) — a SHORT freshness window that initiate-deletion checks.
//      On failure: `anonymize:fail:{customerId}` counter INCR with
//      30min TTL; after 5 failures the customer is locked out.
//   3. POST /api/me/data/initiate-deletion  — REQUIRES the 60s
//      verify-marker. PARKS the kernel DEFER and stores the receipt.
//      Returns the 24h cancel window.
//   4. POST /api/me/data/cancel-deletion    — within the 24h grace,
//      cancels the parked deletion AND sets
//      `anonymize:cancel-cooldown:{customerId}` for 30min so the next
//      initiate-deletion is refused. This kills the harassment loop.
//
// OTP TTL = 5 minutes (vs 10 for login). The reasoning: anonymize is
// irreversible. Tightening the replay window halves the time an
// attacker has to intercept + replay a stolen code.
//
// ── Redis keys (CLAUDE.md rule #7 — `rk()` always) ────────────────────────
//
//   - `anonymize:otp:{customerId}`              — value `"1"`, TTL 300s
//                                                  (5min). Existence
//                                                  == fresh OTP sent.
//   - `anonymize:otp_verified:{customerId}`     — value `"1"`, TTL 60s.
//                                                  Existence == verify
//                                                  succeeded recently.
//                                                  P0-11 step gate.
//   - `anonymize:fail:{customerId}`             — counter, TTL 1800s
//                                                  (30min). 5 → lockout.
//                                                  P0-11 brute force.
//   - `anonymize:cancel-cooldown:{customerId}`  — value `"1"`, TTL 1800s
//                                                  (30min). Existence
//                                                  blocks initiate.
//                                                  P0-11 cancel-cooldown.
//   - `anonymize:pending:{customerId}`          — JSON receipt, TTL
//                                                  86400s (24h).
//                                                  Existence == parked.
//
// Twilio Verify is the source of truth for the OTP code — these
// helpers record the verify outcome and the freshness marker.

import { getRedisClient, rk } from "@ibatexas/tools";
import twilio from "twilio";

// ── NEW-P0-X8: empty-string customerId guard ─────────────────────────────
//
// Every Redis-key builder in this file takes a `customerId` string. An
// empty string would collapse all "" customers onto the same Redis key
// namespace (`anonymize:otp:`, `anonymize:fail:`, `anonymize:pending:`,
// …) — a colliding-state attack and a stolen-JWT amplifier.
//
// `requireAuth` already rejects empty `customerId` upstream, but every
// helper here repeats the guard so a future refactor that adds a new
// caller (CLI, subscriber, …) cannot accidentally drop the gate.
class InvalidCustomerIdError extends Error {
  constructor() {
    super("Empty customerId rejected — anonymize gate keys must be tenant-scoped.");
    this.name = "InvalidCustomerIdError";
  }
}

function assertCustomerId(customerId: string | null | undefined): asserts customerId is string {
  if (customerId == null || typeof customerId !== "string" || customerId === "") {
    throw new InvalidCustomerIdError();
  }
}

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * OTP freshness window for anonymize, in seconds.
 *
 * 5 minutes (vs 10 for the login OTP) — the operation is irreversible,
 * so we tighten the replay window. Matches `CUSTOMER_OTP_FRESHNESS_SECONDS`
 * in `@ibatexas/pack-customer-onboarding/types`.
 */
export const ANONYMIZE_OTP_TTL_SECONDS = 300;

/**
 * Grace window between parking the DEFER and the actual anonymize, in
 * seconds. 24h per the master plan §"Customer destructive flow" and
 * `CUSTOMER_ANONYMIZE_GRACE_HOURS = 24`.
 */
export const ANONYMIZE_GRACE_TTL_SECONDS = 24 * 60 * 60;

// ── Twilio client (cloned from auth.ts so the gate is self-contained) ────

function twilioClient(): ReturnType<typeof twilio> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !auth) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
  return twilio(sid, auth);
}

function verifySid(): string {
  const sid = process.env.TWILIO_VERIFY_SID;
  if (!sid) throw new Error("TWILIO_VERIFY_SID not set");
  return sid;
}

function otpChannel(): "sms" | "whatsapp" {
  const ch = process.env.TWILIO_OTP_CHANNEL ?? "sms";
  if (ch !== "sms" && ch !== "whatsapp") {
    throw new Error(`TWILIO_OTP_CHANNEL must be "sms" or "whatsapp", got "${ch}"`);
  }
  return ch;
}

// ── OTP send + verify (Twilio Verify) ──────────────────────────────────────

/**
 * Issue a fresh Twilio Verify OTP to the customer's phone.
 * The Twilio side stores the code; we only record that an OTP was
 * requested (so the DELETE endpoint can reject an unverified request
 * fast without hitting Twilio again).
 */
export async function sendAnonymizeOtp(phone: string): Promise<void> {
  await twilioClient()
    .verify.v2.services(verifySid())
    .verifications.create({ to: phone, channel: otpChannel() });
}

/**
 * Verify a Twilio OTP code. Returns `true` on `approved`, `false`
 * otherwise (expired, wrong code, no pending verification). Errors are
 * swallowed — the caller treats any non-`approved` response as a
 * generic verification failure and surfaces a pt-BR error.
 */
export async function verifyAnonymizeOtp(phone: string, code: string): Promise<boolean> {
  try {
    const verification = await twilioClient()
      .verify.v2.services(verifySid())
      .verificationChecks.create({ to: phone, code });
    return verification.status === "approved";
  } catch {
    return false;
  }
}

// ── Redis-backed freshness marker ────────────────────────────────────────

/**
 * Record that the customer just verified their OTP — the DELETE step
 * reads this within `ANONYMIZE_OTP_TTL_SECONDS` to assert freshness.
 *
 * Stores `rk('anonymize:otp:{customerId}') = "1"` with 300s TTL.
 */
export async function markOtpFresh(customerId: string): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.set(rk(`anonymize:otp:${customerId}`), "1", {
    EX: ANONYMIZE_OTP_TTL_SECONDS,
  });
}

/**
 * Check whether the customer has a fresh anonymize OTP marker.
 *
 * Returns `true` if the marker exists and has TTL > 0. Returns `false`
 * if missing or expired. Does NOT delete the marker — the DELETE step
 * is the one that consumes it (single-use semantics).
 */
export async function hasFreshOtp(customerId: string): Promise<boolean> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  const value = await redis.get(rk(`anonymize:otp:${customerId}`));
  return value !== null;
}

/**
 * Consume the OTP marker — single-use. Called by the DELETE endpoint
 * after envelope dispatch succeeds (so a retry that fails dispatch can
 * keep the marker).
 */
export async function consumeOtpMarker(customerId: string): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.del(rk(`anonymize:otp:${customerId}`));
}

// ── P0-11: verify-step marker + brute-force counter + cancel cooldown ────

/**
 * Tight 60-second window between verify-otp success and the
 * initiate-deletion call. This is the W4 P0-11 hardening: a stolen
 * JWT alone is no longer enough — the attacker must also possess a
 * code that was just verified, AND make the next call within 60s.
 */
export const ANONYMIZE_VERIFY_TTL_SECONDS = 60;

/**
 * Brute-force lockout TTL — 30 minutes. After 5 failed OTP verifies
 * within this window the customer is locked out and must wait the
 * window out before another attempt.
 */
export const ANONYMIZE_FAIL_TTL_SECONDS = 30 * 60;
export const ANONYMIZE_FAIL_THRESHOLD = 5;

/**
 * Cancel-cooldown TTL — 30 minutes. After a cancel-deletion the
 * customer cannot re-initiate within this window (kills the
 * cancel-then-reinitiate harassment + Twilio-spend loop).
 */
export const ANONYMIZE_CANCEL_COOLDOWN_SECONDS = 30 * 60;

/**
 * Mark the customer as "OTP recently verified" — initiate-deletion
 * must observe this marker within 60s of the verify-otp call.
 */
export async function markOtpVerified(customerId: string): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.set(rk(`anonymize:otp_verified:${customerId}`), "1", {
    EX: ANONYMIZE_VERIFY_TTL_SECONDS,
  });
}

/**
 * Check whether the customer's verify-otp call is still fresh (within
 * the 60s window). Returns `true` if the marker exists, `false`
 * otherwise. Does NOT consume — initiate-deletion consumes it after
 * the receipt is parked.
 */
export async function hasFreshVerifiedOtp(customerId: string): Promise<boolean> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  const value = await redis.get(rk(`anonymize:otp_verified:${customerId}`));
  return value !== null;
}

/**
 * Consume the verify-otp freshness marker — single use. Called by
 * initiate-deletion after successful PARK so the same verification
 * cannot be reused.
 */
export async function consumeOtpVerifiedMarker(customerId: string): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.del(rk(`anonymize:otp_verified:${customerId}`));
}

/**
 * Increment the per-customer brute-force counter. Returns the new
 * count. The first INCR on a missing key sets the 30min TTL.
 *
 * The redis client returns the post-increment value; we ensure TTL is
 * set (idempotent via `EXPIRE NX` semantics emulated as a defensive
 * EXPIRE call which is harmless if TTL is already set).
 */
export async function incrementOtpFailureCount(customerId: string): Promise<number> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  const key = rk(`anonymize:fail:${customerId}`);
  const next = await redis.incr(key);
  if (next === 1) {
    // First failure → set the TTL.
    await redis.expire(key, ANONYMIZE_FAIL_TTL_SECONDS);
  }
  return next;
}

/**
 * Read the current brute-force counter without incrementing. Used by
 * verify-otp to fast-refuse a locked-out customer before consuming a
 * Twilio verification round-trip.
 */
export async function getOtpFailureCount(customerId: string): Promise<number> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  const value = await redis.get(rk(`anonymize:fail:${customerId}`));
  return value === null ? 0 : Number.parseInt(value, 10) || 0;
}

/**
 * Reset the per-customer brute-force counter. Called on successful
 * OTP verify so honest customers don't accumulate stale failures.
 */
export async function resetOtpFailureCount(customerId: string): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.del(rk(`anonymize:fail:${customerId}`));
}

// ── P0-X-OTP — Atomic INCR + threshold check (audit 03 R6) ───────────────
//
// Pre-fix race: verify-otp performed
//   getOtpFailureCount (GET) → verifyAnonymizeOtp (Twilio ~300ms) →
//   incrementOtpFailureCount (INCR-on-fail)
// All N concurrent attempts in the ~300ms Twilio round-trip read the
// SAME starting `failsBefore` value, all passed the threshold check,
// all proceeded to verify. Effective brute-force budget = N × threshold
// rather than threshold. ~30 free attempts per ~300ms burst per the
// audit's measurement.
//
// Fix: Lua script that atomically (1) INCRs the counter, (2) sets the
// 30min TTL on the first INCR, (3) compares the post-INCR count against
// the threshold, (4) on lockout sets a separate `anonymize:lockout`
// sentinel with its own TTL (so a successful OTP after lockout doesn't
// reset the lockout window). Returns `[allowed, count]` so the caller
// can refuse before the Twilio round-trip.
//
// Order of operations:
//   1. Acquire (this function) — INCR + check.
//   2. Call Twilio verify.
//   3. On success: resetOtpFailureCount + (optionally) DECR back the
//      pre-incremented attempt so honest legitimate retries don't
//      contribute. On failure: counter stays incremented.
//
// Lockout sentinel:
//   - `anonymize:lockout:{customerId}` SET when count > threshold.
//   - TTL = ANONYMIZE_FAIL_TTL_SECONDS.
//   - Survives any subsequent `resetOtpFailureCount`, ensuring lockout
//     persists for the full 30-min window even if an honest attempt
//     succeeds inside the lockout (which it shouldn't be allowed to —
//     the pre-check fast-fails).

const OTP_ACQUIRE_ATTEMPT_LUA = `
  local fail_key = KEYS[1]
  local lockout_key = KEYS[2]
  local ttl = tonumber(ARGV[1])
  local threshold = tonumber(ARGV[2])
  local lockout_ttl = tonumber(ARGV[3])
  -- Fast-fail: if lockout sentinel exists, refuse without incrementing.
  if redis.call("EXISTS", lockout_key) == 1 then
    local current = tonumber(redis.call("GET", fail_key)) or 0
    return {0, current, 1}
  end
  local count = redis.call("INCR", fail_key)
  if count == 1 then
    redis.call("EXPIRE", fail_key, ttl)
  end
  if count > threshold then
    redis.call("SET", lockout_key, "1", "EX", lockout_ttl)
    return {0, count, 0}
  end
  return {1, count, 0}
`;

export type OtpAttemptResult =
  | { readonly kind: "allowed"; readonly count: number }
  | {
      readonly kind: "locked_out";
      readonly count: number;
      readonly fromSentinel: boolean;
    };

/**
 * Atomically acquire a brute-force attempt slot. INCRs the failure
 * counter, sets the 30min TTL on first INCR, and checks the post-INCR
 * count against the threshold. If the threshold is exceeded, a
 * lockout sentinel is set (separate key, separate TTL) so subsequent
 * attempts fast-fail without Twilio round-trips.
 *
 * Callers MUST call `resetOtpFailureCount` on Twilio success so honest
 * customers don't accumulate the pre-incremented attempt. The lockout
 * sentinel does NOT survive a successful reset by design: a customer
 * who verifies on the 5th attempt has not yet triggered lockout (count
 * <= threshold), so no sentinel was set.
 */
export async function acquireOtpAttempt(
  customerId: string,
): Promise<OtpAttemptResult> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  const failKey = rk(`anonymize:fail:${customerId}`);
  const lockoutKey = rk(`anonymize:lockout:${customerId}`);
  const raw = (await (
    redis as unknown as {
      eval: (
        script: string,
        opts: { keys: string[]; arguments: string[] },
      ) => Promise<unknown>;
    }
  ).eval(OTP_ACQUIRE_ATTEMPT_LUA, {
    keys: [failKey, lockoutKey],
    arguments: [
      String(ANONYMIZE_FAIL_TTL_SECONDS),
      String(ANONYMIZE_FAIL_THRESHOLD),
      String(ANONYMIZE_FAIL_TTL_SECONDS),
    ],
  })) as unknown;
  const arr = Array.isArray(raw)
    ? raw
    : [
        (raw as { 0: number })?.[0],
        (raw as { 1: number })?.[1],
        (raw as { 2: number })?.[2],
      ];
  const allowed = Number(arr[0]);
  const count = Number(arr[1]);
  const fromSentinel = Number(arr[2]) === 1;
  if (allowed === 1) {
    return { kind: "allowed", count };
  }
  return { kind: "locked_out", count, fromSentinel };
}

/**
 * Clear the lockout sentinel. Used by ops/tests; NOT called during
 * normal flow (a lockout window must run its TTL).
 */
export async function clearOtpLockout(customerId: string): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.del(rk(`anonymize:lockout:${customerId}`));
}

/**
 * Persist the 30-min cancel-cooldown marker. Existence blocks
 * `/api/me/data/initiate-deletion` until expiry.
 */
export async function setCancelCooldown(customerId: string): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.set(rk(`anonymize:cancel-cooldown:${customerId}`), "1", {
    EX: ANONYMIZE_CANCEL_COOLDOWN_SECONDS,
  });
}

/**
 * Read the cancel-cooldown marker. Returns `true` while the cooldown
 * window is active (initiate-deletion must refuse).
 */
export async function hasCancelCooldown(customerId: string): Promise<boolean> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  const value = await redis.get(rk(`anonymize:cancel-cooldown:${customerId}`));
  return value !== null;
}

// ── Pending-deletion receipt (24h grace) ─────────────────────────────────

export interface PendingAnonymizeReceipt {
  /** Epoch ms when the deletion intent was parked. */
  readonly parkedAt: number;
  /** The intent hash from the parked envelope — for audit linkage. */
  readonly intentHash: string;
  /** The OTP token used to authorize — opaque, NOT replayable. */
  readonly otpTokenHint: string;
}

/**
 * Persist the pending-deletion receipt so the cancel-deletion endpoint
 * can prove an active grace window exists.
 *
 * Stores `rk('anonymize:pending:{customerId}') = JSON(receipt)` with
 * 24h TTL. The TTL matches the kernel's DEFER timeout so a
 * never-cancelled deletion's receipt expires exactly when the grace
 * resolver fires.
 */
export async function persistPendingDeletion(
  customerId: string,
  receipt: PendingAnonymizeReceipt,
): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.set(
    rk(`anonymize:pending:${customerId}`),
    JSON.stringify(receipt),
    { EX: ANONYMIZE_GRACE_TTL_SECONDS },
  );
}

/**
 * Read the pending-deletion receipt for a customer. Returns `null` if
 * no deletion is in flight (no receipt or expired).
 */
export async function readPendingDeletion(
  customerId: string,
): Promise<PendingAnonymizeReceipt | null> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  const raw = await redis.get(rk(`anonymize:pending:${customerId}`));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingAnonymizeReceipt;
  } catch {
    return null;
  }
}

/**
 * Clear the pending-deletion receipt. Called both by the cancel endpoint
 * (customer aborted) and by the grace resolver (after running anonymize).
 */
export async function clearPendingDeletion(customerId: string): Promise<void> {
  assertCustomerId(customerId);
  const redis = await getRedisClient();
  await redis.del(rk(`anonymize:pending:${customerId}`));
}

// Export the assertion + error for tests; route code should rely on
// requireAuth's gate, not catch InvalidCustomerIdError.
export { InvalidCustomerIdError };
