// anonymize-otp-gate.ts — LGPD-anonymize OTP freshness gate.
//
// ── Task 14 (M3) — LGPD anonymize 3-endpoint flow ─────────────────────────
//
// The LGPD anonymize path is the most destructive customer-driven
// operation we expose (per investigation 08 P0 #2: "one-click
// destructive, unconfirmed, unadjudicated"). Three endpoints make it
// safe:
//
//   1. POST /api/me/data/initiate-deletion — emits a fresh OTP via
//      Twilio Verify, stores a 5-minute marker in Redis.
//   2. DELETE /api/me/data?token={otpCode} — verifies the OTP, builds
//      the `customer.anonymize` envelope, parks the kernel's DEFER.
//   3. POST /api/me/data/cancel-deletion — REFUSEs the parked
//      anonymize within the 24h grace window.
//
// OTP TTL = 5 minutes (vs 10 for login). The reasoning: anonymize is
// irreversible. Tightening the replay window halves the time an
// attacker has to intercept + replay a stolen code.
//
// ── Redis keys (CLAUDE.md rule #7 — `rk()` always) ────────────────────────
//
//   - `anonymize:otp:{customerId}`     — value `"1"`, TTL 300s (5min).
//                                         Existence == fresh OTP.
//   - `anonymize:pending:{customerId}` — JSON receipt, TTL 86400s (24h).
//                                         Existence == parked deletion.
//
// Twilio Verify is the source of truth for the OTP code — this gate
// just records that the verify check succeeded, so the DELETE step can
// re-assert freshness without an extra Twilio round-trip.

import { getRedisClient, rk } from "@ibatexas/tools";
import twilio from "twilio";

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
  const redis = await getRedisClient();
  await redis.del(rk(`anonymize:otp:${customerId}`));
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
  const redis = await getRedisClient();
  await redis.del(rk(`anonymize:pending:${customerId}`));
}
