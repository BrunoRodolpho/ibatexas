/**
 * @ibatexas/pack-payments — domain types.
 *
 * IbateXas's fifth first-party Pack: governs the payment domain
 * (Stripe + PIX + cash + refund + dispute). Mirrors the
 * `pack-customer-onboarding` / `pack-reservations` layout so the
 * scaffolding pattern stays uniform across first-party Packs.
 *
 * Authoritative intent vocabulary:
 * `docs/adjudicate-migration/governance/01-intent-taxonomy.md`
 * §"Domain: payment". The kinds enumerated here track that taxonomy
 * exactly — if a new kind appears in
 * `packages/domain/src/services/payment-command.service.ts` or in a future
 * payment-touching route, update the taxonomy doc FIRST.
 *
 * # Intent surface (governance §"payment" + W3 + W5 additions)
 *
 *   - payment.create                — SYSTEM. Initial Payment row for an
 *                                     order. Charge-create umbrella for
 *                                     the legacy `paymentCmdSvc.create`
 *                                     path.
 *   - payment.charge.create         — SYSTEM. Taxonomy-canonical alias for
 *                                     `payment.create`; carried for symmetry
 *                                     with the rest of `payment.charge.*`.
 *   - payment.charge.confirm        — SYSTEM/WEBHOOK. Stripe
 *                                     `payment_intent.succeeded`.
 *   - payment.charge.fail           — SYSTEM/WEBHOOK. Stripe
 *                                     `payment_intent.payment_failed`.
 *   - payment.charge.expire         — SYSTEM. PIX expiry checker.
 *   - payment.charge.cancel         — SYSTEM/WEBHOOK. Stripe
 *                                     `payment_intent.canceled`.
 *   - payment.pix.regenerate        — UNTRUSTED. Customer-driven PIX QR
 *                                     regeneration. Composite (cancel-old
 *                                     + create-new + bump-counter); the
 *                                     rate cap is in this pack as a state
 *                                     guard (W3 P0-2 migration).
 *   - payment.method.switch         — UNTRUSTED. Customer switching
 *                                     between PIX/card/cash.
 *   - payment.retry                 — UNTRUSTED. Payment retry after a
 *                                     non-terminal failure.
 *   - payment.refund.issue          — TRUSTED. Staff-initiated refund;
 *                                     magnitude decision ladder lives in
 *                                     this Pack (W3 P0-1 migration).
 *   - payment.refund.confirm        — SYSTEM/WEBHOOK. Stripe
 *                                     `charge.refunded`.
 *   - payment.dispute.open          — WEBHOOK. Stripe
 *                                     `charge.dispute.created` — always
 *                                     ESCALATE.
 *   - payment.cash.confirm          — TRUSTED. Staff confirming cash at
 *                                     the counter.
 *   - payment.waive                 — TRUSTED. Admin-only payment waive;
 *                                     always REQUEST_CONFIRMATION.
 *   - payment.status.force          — TRUSTED. Admin force-status change;
 *                                     always REQUEST_CONFIRMATION.
 *   - payment.status.transition     — SYSTEM/TRUSTED. Direct status change
 *                                     (e.g., admin force-confirm cash,
 *                                     job marking pix_expired). Migrated
 *                                     from `paymentProjectionPolicyBundle`.
 *   - payment.status.reconcile      — SYSTEM. Reconciliation from Stripe
 *                                     webhook event. Migrated from
 *                                     `paymentProjectionPolicyBundle`.
 *
 * # Composite intent notes
 *
 * Several payment lifecycle operations are conceptually atomic but
 * decompose into multiple envelopes today:
 *
 *   - `payment.retry`   — issues cancel-old (`payment.status.transition`)
 *                          then create-new (`payment.create`). The retry
 *                          envelope itself is REQUEST_CONFIRMATION above
 *                          the daily-retry-cap; the executor pulls the
 *                          atomic operations.
 *
 *   - `payment.pix.regenerate` — same shape (cancel-old + create-new +
 *                          bump-counter). The bump-counter guard caps at
 *                          `MAX_PIX_REGENERATIONS_PER_PAYMENT` (default 5).
 *
 * # Migration from `paymentProjectionPolicyBundle`
 *
 * The `packages/domain/src/services/__shared__/payment-projection-policy.ts`
 * file remains a re-export shim per Decision D8 (parallel-surface during
 * incremental adopter migration). New callers should import this Pack's
 * `paymentsPolicyBundle` directly.
 */

import { createSystemTaintPolicy } from "@adjudicate/primitives"

export type PaymentIntentKind =
  | "payment.create"
  | "payment.charge.create"
  | "payment.charge.confirm"
  | "payment.charge.fail"
  | "payment.charge.expire"
  | "payment.charge.cancel"
  | "payment.pix.regenerate"
  | "payment.method.switch"
  | "payment.retry"
  | "payment.refund.issue"
  | "payment.refund.confirm"
  | "payment.dispute.open"
  | "payment.cash.confirm"
  | "payment.waive"
  | "payment.status.force"
  | "payment.status.transition"
  | "payment.status.reconcile"

// ── Payloads ────────────────────────────────────────────────────────────

export interface PaymentCreatePayload {
  readonly orderId: string
  readonly method: "pix" | "card" | "cash"
  /** Centavos integer per CLAUDE.md rule #2. */
  readonly amountInCentavos: number
  readonly stripePaymentIntentId?: string
  readonly pixExpiresAt?: string
  readonly idempotencyKey?: string
}

/**
 * Symmetric alias of `PaymentCreatePayload`. Taxonomy uses
 * `payment.charge.create` for the canonical charge-creation kind; the
 * legacy `payment.create` literal is also in the surface to preserve
 * existing audit-record vocabulary. Both share this payload shape.
 */
export type PaymentChargeCreatePayload = PaymentCreatePayload

export interface PaymentChargeConfirmPayload {
  readonly orderId: string
  readonly paymentId: string
  readonly wireStatus: string
  readonly stripeEventId: string
}

export interface PaymentChargeFailPayload {
  readonly orderId: string
  readonly paymentId: string
  readonly reason: string
}

export interface PaymentChargeExpirePayload {
  readonly paymentId: string
  readonly reason: "pix_expired"
}

export interface PaymentChargeCancelPayload {
  readonly paymentId: string
  readonly reason: string
}

/**
 * PIX regeneration. Composite kind: the executor cancels the old PIX
 * charge, creates a new one, and bumps the regeneration counter. The
 * count cap lives in this Pack as a state guard.
 */
export interface PaymentPixRegeneratePayload {
  readonly orderId: string
  readonly paymentId: string
  /** Current regeneration count snapshot — for optimistic concurrency. */
  readonly currentRegenerationCount: number
}

export interface PaymentMethodSwitchPayload {
  readonly orderId: string
  readonly fromMethod: "pix" | "card" | "cash"
  readonly toMethod: "pix" | "card" | "cash"
  readonly customerId: string
}

export interface PaymentRetryPayload {
  readonly orderId: string
  readonly previousPaymentId: string
  readonly newMethod?: "pix" | "card" | "cash"
}

/**
 * W3 P0-1: refund magnitude is part of the envelope so the kernel
 * adjudicates the AMOUNT (not just status). Decision ladder
 * (governance §"04-decision-policy.md"):
 *
 *   - amount ≤ R$500 (50_000 centavos)              → EXECUTE
 *   - R$500 < amount ≤ R$1000 (100_000 centavos)    → REQUEST_CONFIRMATION
 *   - amount > R$1000                               → ESCALATE
 */
export interface PaymentRefundIssuePayload {
  readonly paymentId: string
  /** Centavos integer per CLAUDE.md rule #2. */
  readonly refundAmountCentavos: number
  /** Refundable balance snapshot at envelope-build time (centavos). */
  readonly refundableBalanceCentavos: number
  /** Total amount of the original payment (centavos). */
  readonly amountInCentavos: number
  /** Existing refunded-amount sum (centavos). */
  readonly currentRefundedCentavos: number
  readonly actor: "admin" | "system"
  readonly actorId?: string
  readonly reason?: string
}

export interface PaymentRefundConfirmPayload {
  readonly paymentId: string
  readonly wireStatus: string
  readonly stripeEventId: string
}

export interface PaymentDisputeOpenPayload {
  readonly paymentId: string
  readonly stripeEventId: string
  readonly disputeAmountCentavos?: number
}

export interface PaymentCashConfirmPayload {
  readonly orderId: string
  readonly paymentId: string
  /** Centavos integer per CLAUDE.md rule #2. */
  readonly amountCentavos: number
  readonly staffId: string
}

export interface PaymentWaivePayload {
  readonly paymentId: string
  readonly reason: string
  readonly adminId: string
}

export interface PaymentStatusForcePayload {
  readonly paymentId: string
  readonly newStatus: string
  readonly reason: string
  readonly adminId: string
}

export interface PaymentStatusTransitionPayload {
  readonly paymentId: string
  readonly newStatus: string
  readonly actor: "admin" | "system" | "customer"
  readonly actorId?: string
  readonly reason?: string
  readonly expectedVersion?: number
}

export interface PaymentStatusReconcilePayload {
  readonly paymentId: string
  readonly newStatus: string
  readonly stripeEventId: string
  /** ISO-8601 string; the executor compares timestamps. */
  readonly stripeEventTimestamp?: string
  readonly expectedOrderId?: string
}

/**
 * Discriminated payload union — typed by `kind`. Guards narrow via
 * `envelope.kind` and may cast `envelope.payload` to the matching
 * member; payload contracts are validated by the guards in
 * `./policies.ts` and by the wire schema upstream.
 */
export type PaymentPayload =
  | PaymentCreatePayload
  | PaymentChargeCreatePayload
  | PaymentChargeConfirmPayload
  | PaymentChargeFailPayload
  | PaymentChargeExpirePayload
  | PaymentChargeCancelPayload
  | PaymentPixRegeneratePayload
  | PaymentMethodSwitchPayload
  | PaymentRetryPayload
  | PaymentRefundIssuePayload
  | PaymentRefundConfirmPayload
  | PaymentDisputeOpenPayload
  | PaymentCashConfirmPayload
  | PaymentWaivePayload
  | PaymentStatusForcePayload
  | PaymentStatusTransitionPayload
  | PaymentStatusReconcilePayload

// ── Context (per-turn caller identity / channel surface) ────────────────

/**
 * Per-turn context the planner consumes. Structurally independent from
 * `OrderContext` / `CustomerOnboardingContext`. Payment context is
 * tiny — most policy decisions are driven by state, not context.
 */
export interface PaymentContext {
  readonly actor: {
    readonly principal: "user" | "system" | "staff" | "admin" | "webhook"
    readonly id?: string
  }
}

// ── State (per-session snapshot the kernel adjudicates against) ─────────

/**
 * Per-session state shape. Adopters embed this inside their own session
 * context. Mirrors the relevant slice of `PaymentProjectionState` from
 * `payment-projection-policy.ts` (the W3 bundle being migrated).
 *
 * # Fields
 *   - `exists`                    Payment row exists in the projection.
 *                                  False for `payment.create` / `.charge.create`.
 *   - `currentStatus`              Current wire status (e.g. "pending", "paid").
 *   - `currentMethod`              Current settlement method.
 *   - `version`                    Optimistic-concurrency version.
 *   - `orderId`                    Order id the payment belongs to —
 *                                  ownership cross-check.
 *   - `isTerminal`                 True when status ∈ TERMINAL_PAYMENT_STATUSES.
 *   - `refundedAmountCentavos`     Centavos — current refunded sum.
 *   - `amountInCentavos`           Centavos — original payment amount.
 *   - `regenerationCount`          PIX regeneration counter snapshot.
 *   - `dailyRetryCount`            Number of retries this customer has issued
 *                                  in the current 24h window (rate-limit guard).
 *   - `staffRefundDailyTotalCentavos`  Cumulative refund total this staff
 *                                  member has issued today (P1-I drip cap).
 */
export interface PaymentState {
  readonly ctx: PaymentContext & {
    /** Tenant this request operates on (AuthReviewer-009 / RC-A1 D-12). Single-tenant
     *  today; the `requireTenantBinding` authGuard REFUSEs a mismatch, no-op when absent. */
    readonly tenantId?: string
    readonly exists: boolean
    readonly currentStatus?: string
    readonly currentMethod?: "pix" | "card" | "cash"
    readonly version?: number
    readonly orderId?: string
    readonly isTerminal?: boolean
    readonly refundedAmountCentavos?: number
    readonly amountInCentavos?: number
    readonly regenerationCount?: number
    readonly dailyRetryCount?: number
    readonly staffRefundDailyTotalCentavos?: number
    /**
     * D1 (SDD Inv 11 strengthen / §5 fresh conjunct / §G ledger) — TRUE iff this
     * payment projection was read LIVE this turn (the `must_read_this_turn`
     * freshness policy ⟹ `sourceMode == "live"`; "cache cannot masquerade as
     * live"). The host (`resolve-and-assemble.ts` `buildPaymentCtx`) stamps it on
     * a live active-payment read. The refund-freshness business guard requires it
     * `=== true` whenever the host has injected `state.authority` (the 4-conjunct
     * refund-authority enforcement seam): an absent/false marker ⟹ a stale read ⟹
     * REFUSE, so stale authority can never authorize a refund off a cached view.
     */
    readonly paymentReadThisTurn?: boolean
  }
}

// ── Refund magnitude thresholds (centavos — CLAUDE.md rule #2) ──────────

function readEnvCentavos(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 0) return fallback
  return n
}

/**
 * REQUEST_CONFIRMATION threshold for refunds. Default R$500
 * (50_000 centavos). Above this threshold and ≤ ESCALATE threshold,
 * the kernel returns REQUEST_CONFIRMATION; the operator UX (two-step
 * receipt) is a stacked gate.
 */
export function getRefundConfirmThresholdCentavos(): number {
  return readEnvCentavos("REFUND_CONFIRM_THRESHOLD_CENTAVOS", 50_000)
}

/**
 * ESCALATE threshold for refunds. Default R$1000 (100_000 centavos).
 * Mirrors `pack-payments-pix`'s `ESCALATE_REFUND_THRESHOLD_CENTAVOS`.
 */
export function getRefundEscalateThresholdCentavos(): number {
  return readEnvCentavos("REFUND_ESCALATE_THRESHOLD_CENTAVOS", 100_000)
}

/**
 * Per-payment PIX regeneration cap. Default 5 attempts; env override
 * `MAX_PIX_REGENERATIONS_PER_PAYMENT`.
 */
export function getMaxPixRegenerationsPerPayment(): number {
  const raw = process.env["MAX_PIX_REGENERATIONS_PER_PAYMENT"]
  if (!raw) return 5
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 1) return 5
  return n
}

/**
 * Per-customer daily retry cap. Default 3 retries per 24h window;
 * env override `MAX_PAYMENT_RETRIES_PER_DAY`.
 */
export function getMaxPaymentRetriesPerDay(): number {
  const raw = process.env["MAX_PAYMENT_RETRIES_PER_DAY"]
  if (!raw) return 3
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 1) return 3
  return n
}

// ── Taint policy ────────────────────────────────────────────────────────

/**
 * Most payment ops are SYSTEM-only — the LLM never authorizes a Stripe
 * reconcile, a webhook event, or a status flip. Customer-driven kinds
 * (`payment.pix.regenerate`, `payment.method.switch`, `payment.retry`)
 * accept UNTRUSTED with route-layer auth.
 *
 * Staff-only kinds (`payment.refund.issue`, `payment.cash.confirm`,
 * `payment.waive`, `payment.status.force`) require TRUSTED — the route
 * layer attaches that taint after `requireManagerRole` succeeds.
 *
 * Webhook-only kinds (`payment.charge.confirm/fail/cancel`,
 * `payment.refund.confirm`, `payment.dispute.open`) flow through the
 * SYSTEM-tainted bucket (Stripe signature verification happens at the
 * route layer).
 */
export const paymentsTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [
    "payment.create",
    "payment.charge.create",
    "payment.charge.confirm",
    "payment.charge.fail",
    "payment.charge.expire",
    "payment.charge.cancel",
    "payment.refund.confirm",
    "payment.dispute.open",
    "payment.status.reconcile",
  ],
  userMinimum: "UNTRUSTED",
})
