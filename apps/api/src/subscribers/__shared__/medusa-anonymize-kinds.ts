// medusa-anonymize-kinds.ts — audit-2026-05-24 H3 Wave B.
//
// ── Why this module exists ────────────────────────────────────────────────
//
// Wave A1 (`packages/domain/src/services/customer.service.ts`) scrubs the
// 7 in-process Prisma surfaces inside a single transaction. Surface 8 —
// the Medusa-side customer row — lives in a separate Postgres database
// reachable only via HTTP admin API, so it CANNOT participate in the
// Prisma TX. Wave B implements the SYNTHESIS-recommended compensation +
// retry pattern: after the Prisma TX commits, the domain service emits
// `customer.anonymize.medusa.pending`; a new subscriber consumes it,
// PATCHes the Medusa customer record, and emits `.confirmed` on success
// or `.failed` on Medusa-side errors. A BullMQ retry job sweeps any
// pending events that lack a confirmed counterpart and re-publishes them;
// after N attempts the chain emits `.exhausted` and pages the operator.
//
// Following the Wave A1 precedent (`SCRUB_AUDIT_KINDS` const-array in
// `customer.service.ts`), these are AUDIT KINDS — they label scrub-record
// envelopes only, NOT policy-gated intents. They are NOT promoted to
// `@ibatexas/pack-customer-onboarding`'s intent vocabulary. The taxonomy
// matches `customer.anonymize.<surface>.<state>`.
//
// ── States ────────────────────────────────────────────────────────────────
//
//   pending    — fired by `anonymizeCustomer` after Prisma TX commits.
//                Carries (medusaId, customerId, parkedIntentHash).
//                Consumers: subscriber + retry job.
//   confirmed  — fired by the subscriber after a successful Medusa-side
//                PATCH. Closes the compensation loop.
//   failed     — fired by the subscriber when Medusa returns a 4xx/5xx or
//                the call throws. Retry job consumes pending events that
//                lack a `confirmed`; `failed` records are forensic only.
//   exhausted  — fired by the retry job after `MAX_RETRIES` attempts. A
//                CRITICAL operator alert; manual intervention required.
//
// ── PII discipline (CLAUDE.md rule #9) ────────────────────────────────────
//
// All four kinds carry payloads with non-PII identifiers only (UUID
// customerId, Medusa customer-id UUID, intent-hash strings, ISO
// timestamps). Never name / email / phone / cpf.

/**
 * NATS event subjects + audit-record `IntentEnvelope.kind` values for the
 * Wave-B Medusa compensation chain. Keep this list in sync with the
 * `MedusaAnonymizeKind` union below — both the subscriber and the retry
 * job iterate over it to filter audit records by surface.
 */
export const MEDUSA_ANONYMIZE_KINDS = [
  "customer.anonymize.medusa.pending",
  "customer.anonymize.medusa.confirmed",
  "customer.anonymize.medusa.failed",
  "customer.anonymize.medusa.exhausted",
] as const;

export type MedusaAnonymizeKind = (typeof MEDUSA_ANONYMIZE_KINDS)[number];

/**
 * Payload shape carried by every Medusa-anonymize event/audit record.
 *
 * `customerId`         — ibatexas Customer.id (UUID). Stable join key.
 * `medusaId`           — Medusa customer id (UUID). Captured BEFORE the
 *                        Prisma TX nulls Customer.medusaId, so the
 *                        compensation chain still has a target.
 * `parkedIntentHash`   — the originating `customer.anonymize` envelope's
 *                        intentHash. Threads `supersedes` across the chain
 *                        so audit replay can follow request → grace expire
 *                        → Prisma scrub → Medusa scrub → confirmed.
 * `parkedAt`           — ISO timestamp of the parked envelope. Mirrors
 *                        the `Supersession.predecessorAt` field.
 * `attempt`            — 1-based retry counter. The first emission is
 *                        `attempt: 1`; the retry job increments per pass.
 *                        Used by the exhausted-cap logic.
 *
 * No PII. Audit consumers MUST NOT expect name / email / phone / cpf.
 */
export interface MedusaAnonymizePayload {
  readonly customerId: string;
  readonly medusaId: string;
  readonly parkedIntentHash: string;
  readonly parkedAt: string;
  readonly attempt: number;
}

/**
 * Maximum retry attempts before the chain emits `.exhausted` and pages
 * the operator. 12 attempts × 5-minute interval ≈ 1 hour total budget,
 * which matches the SYNTHESIS recommendation ("99.9% consistency in
 * practice for a destructive customer operation"). Beyond 1 hour an
 * operator should be paged for manual intervention — usually a Medusa
 * outage or a permanently-bad customer record.
 */
export const MEDUSA_ANONYMIZE_MAX_ATTEMPTS = 12;

/**
 * Idempotency-key template for the Medusa-side PATCH. The Medusa admin
 * API accepts an `Idempotency-Key` header; the wrapper threads it through
 * (`medusaAdjudicated({ idempotencyKey })`). Re-using the SAME key across
 * every retry of the SAME customer scrub means Medusa de-duplicates the
 * write, preventing duplicate audit rows on the Medusa side and matching
 * the SYNTHESIS idempotency model (`customerId` is the stable key).
 *
 * Format: `customer.anonymize.medusa.{medusaId}.{originalIntentHash}` —
 * stable across retries, unique per (customer, originating anonymize
 * request). The originating intent-hash discriminates the rare case where
 * a customer un-anonymizes (impossible today; anonymize is terminal) and
 * later re-anonymizes via a fresh envelope.
 */
export function medusaAnonymizeIdempotencyKey(
  medusaId: string,
  parkedIntentHash: string,
): string {
  return `customer.anonymize.medusa.${medusaId}.${parkedIntentHash}`;
}
