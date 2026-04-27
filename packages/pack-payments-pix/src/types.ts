/**
 * @adjudicate/pack-payments-pix — domain types.
 *
 * PIX is Brazil's instant-payment rail. A charge has three life-cycle
 * mutations the kernel adjudicates:
 *
 *   pix.charge.create   — generate a QR + copy-paste code; awaiting payer
 *   pix.charge.confirm  — payer scanned, provider settled; capture funds
 *   pix.charge.refund   — return funds to payer (full or partial)
 *
 * `pix.charge.confirm` is the load-bearing intent: the LLM cannot
 * propose it directly (it's TRUSTED — only the provider's webhook may
 * propose it), and when proposed before settlement the kernel DEFERs
 * on `PIX_CONFIRMATION_SIGNAL` until the webhook lands.
 */

import type { IntentEnvelope, TaintPolicy } from "@adjudicate/core";

// ── Intent kinds ────────────────────────────────────────────────────────────

export type PixChargeIntentKind =
  | "pix.charge.create"
  | "pix.charge.confirm"
  | "pix.charge.refund";

/** Convenience: the union as a tuple, for runtime enumeration. */
export const PIX_CHARGE_INTENT_KINDS = [
  "pix.charge.create",
  "pix.charge.confirm",
  "pix.charge.refund",
] as const satisfies ReadonlyArray<PixChargeIntentKind>;

// ── Payloads ────────────────────────────────────────────────────────────────

/**
 * `pix.charge.create` — generate a new PIX charge.
 *
 * `chargeId` is caller-supplied so the adopter controls idempotency
 * (typical pattern: `pix-${orderId}-${attempt}`). The Pack does not
 * mint IDs.
 *
 * `amountCentavos` is integer centavos per the IbateXas hard rule —
 * never floats. PIX itself supports two-decimal precision.
 */
export interface PixChargeCreatePayload {
  readonly chargeId: string;
  readonly amountCentavos: number;
  readonly payerTaxId: string;
  readonly payerName: string;
  readonly payerEmail: string;
  readonly expiresInSeconds: number;
  /** Opaque caller metadata; passed through to the audit record. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * `pix.charge.confirm` — provider-driven settlement.
 *
 * The webhook side adapter constructs this envelope with `taint:
 * "TRUSTED"` after verifying the provider signature. If the LLM ever
 * proposes a confirm (it shouldn't — `pix.charge.confirm` is not in
 * the visible mutating tool set), the taint gate refuses.
 */
export interface PixChargeConfirmPayload {
  readonly chargeId: string;
  /** Provider-reported terminal status. Used for resume-path detection. */
  readonly providerStatus?: PixChargeProviderStatus;
}

/**
 * `pix.charge.refund` — partial or full refund of a captured charge.
 *
 * `amountCentavos` may be less than the original capture (partial) or
 * equal (full). Exceeding the capture is a business-rule REFUSE.
 */
export interface PixChargeRefundPayload {
  readonly chargeId: string;
  readonly amountCentavos: number;
  readonly reason: string;
}

// ── State shape ─────────────────────────────────────────────────────────────

export type PixChargeStatus =
  | "pending"
  | "confirmed"
  | "captured"
  | "expired"
  | "failed"
  | "refunded"
  | "partially_refunded";

/** Provider-side status, mirroring common PSP vocabularies. */
export type PixChargeProviderStatus =
  | "pending"
  | "confirmed"
  | "captured"
  | "failed"
  | "expired";

/**
 * A single charge's domain state, as seen by the kernel guards.
 *
 * `capturedAt` is set on the first successful confirmation; absence is
 * the resume-path discriminator (DEFER vs EXECUTE).
 */
export interface PixChargeRecord {
  readonly id: string;
  readonly status: PixChargeStatus;
  readonly amountCentavos: number;
  readonly capturedAt: string | null;
  readonly refundedAmountCentavos: number;
  readonly expiresAt: string | null;
}

/**
 * Optional rate-limit window. Adopters that don't enforce per-payer
 * limits leave this `undefined`; the rate-limit guard is then a no-op.
 */
export interface PixChargeRateLimitWindow {
  readonly count: number;
  readonly maxPerWindow: number;
}

/**
 * The state shape consumed by `pixPaymentsPolicyBundle`. Adopters
 * project their own state into this shape at the kernel boundary.
 */
export interface PixChargeState {
  readonly charge: PixChargeRecord | null;
  /** Per-payer create-rate window. Optional; if absent, no rate limit applies. */
  readonly rateLimit?: PixChargeRateLimitWindow;
  /**
   * Whether the proposing actor (typically the LLM) is allowed to
   * confirm payments. Almost always `false` — `pix.charge.confirm` is
   * a webhook-only mutation. Kept on state (not just taint) so the
   * adopter can flip it for synthetic test runs.
   */
  readonly allowProposerToConfirm?: boolean;
}

// ── Domain envelope alias ───────────────────────────────────────────────────

export type PixChargeEnvelope = IntentEnvelope<PixChargeIntentKind, unknown>;

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Wire-level signal name a webhook subscriber publishes when a PIX
 * charge settles. The Pack adopts the production-tested name
 * `payment.confirmed` rather than a Pack-namespaced alternative —
 * consistency with existing IbateXas wiring outweighs lexical purity
 * for v0.1. Future versions may rename to `pix.charge.confirmed`; that
 * would be a documented breaking change with a migration note.
 */
export const PIX_CONFIRMATION_SIGNAL = "payment.confirmed";

/** Default DEFER timeout for `pix.charge.confirm` while awaiting settlement. */
export const PIX_DEFAULT_DEFER_TIMEOUT_MS = 15 * 60 * 1000;

/** Default QR validity window passed to PSPs that accept it. */
export const PIX_DEFAULT_EXPIRY_SECONDS = 60 * 60;

/**
 * Provider statuses that count as "settled" for resume-path detection.
 * A charge in any of these statuses skips the DEFER guard and the
 * kernel proceeds to EXECUTE the confirm intent.
 */
export const PIX_CONFIRMED_STATUSES: ReadonlySet<PixChargeStatus> = new Set([
  "confirmed",
  "captured",
]);

// ── Taint policy ────────────────────────────────────────────────────────────

/**
 * PIX intent kinds split into three taint tiers:
 *
 *   pix.charge.create  — UNTRUSTED. The LLM may propose; payer details
 *                        are user-supplied so taint enforces the limit.
 *   pix.charge.confirm — TRUSTED. Only authenticated webhooks may propose.
 *   pix.charge.refund  — TRUSTED. A staff or webhook actor; never the
 *                        customer-facing LLM.
 */
export const pixPaymentsTaintPolicy: TaintPolicy = {
  minimumFor(kind) {
    if (kind === "pix.charge.confirm") return "TRUSTED";
    if (kind === "pix.charge.refund") return "TRUSTED";
    if (kind === "pix.charge.create") return "UNTRUSTED";
    return "UNTRUSTED";
  },
};
