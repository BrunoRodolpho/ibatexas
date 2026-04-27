/**
 * @adjudicate/pack-payments-pix — PolicyBundle.
 *
 * Demonstrates all six kernel Decision outcomes against a single
 * domain. Pack readers can study this file to understand how the IBX
 * adjudication model handles a real payment lifecycle:
 *
 *   pix.charge.create   — REWRITE on out-of-policy expiry; REFUSE on
 *                         invalid amount / rate-limit; otherwise EXECUTE.
 *   pix.charge.confirm  — DEFER when not yet settled; ESCALATE when the
 *                         charge is in a failed terminal status (manual
 *                         review needed); REFUSE for unknown charge or
 *                         already-captured replays; EXECUTE on settle.
 *   pix.charge.refund   — REQUEST_CONFIRMATION above a configurable
 *                         high-value threshold; REFUSE for amount > capture
 *                         or refund-before-capture; otherwise EXECUTE.
 *
 * `default: "REFUSE"` — fail-safe. Any envelope no guard touches is
 * denied by construction.
 */

import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionEscalate,
  decisionRefuse,
  decisionRequestConfirmation,
  decisionRewrite,
} from "@adjudicate/core";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";
import {
  refusePixAmountInvalid,
  refusePixChargeAlreadyCaptured,
  refusePixChargeNotFound,
  refusePixRateLimitExceeded,
  refusePixRefundExceedsCapture,
  refusePixRefundUncapturedCharge,
} from "./refusals.js";
import { createPixPendingDeferGuard } from "./guards.js";
import {
  PIX_DEFAULT_EXPIRY_SECONDS,
  pixPaymentsTaintPolicy,
  type PixChargeConfirmPayload,
  type PixChargeCreatePayload,
  type PixChargeIntentKind,
  type PixChargeRefundPayload,
  type PixChargeState,
} from "./types.js";

type PixGuard = Guard<PixChargeIntentKind, unknown, PixChargeState>;

/**
 * High-value refund threshold. Refunds at or above this trigger
 * REQUEST_CONFIRMATION; below it, the kernel proceeds. Tuned for the
 * IbateXas ticket-size distribution; adopters override by composing a
 * post-bundle guard.
 */
export const PIX_REFUND_CONFIRMATION_THRESHOLD_CENTAVOS = 50_000; // R$ 500.00

/** Maximum allowed expiry window passed to PSPs (24h). */
const PIX_MAX_EXPIRES_IN_SECONDS = 24 * 60 * 60;

// ── Schema/state guards (run as `stateGuards`) ──────────────────────────────

/**
 * REWRITE: clamp `expiresInSeconds` to the policy max. The LLM may
 * propose `expiresInSeconds: 999999999`; the kernel delivers 86400 with
 * a clear basis trail. Adopters who want to refuse instead can compose
 * a stricter guard pre-bundle.
 */
const clampExpiresIn: PixGuard = (envelope) => {
  if (envelope.kind !== "pix.charge.create") return null;
  const payload = envelope.payload as PixChargeCreatePayload;
  if (
    payload.expiresInSeconds > 0 &&
    payload.expiresInSeconds <= PIX_MAX_EXPIRES_IN_SECONDS
  ) {
    return null;
  }
  const clamped =
    payload.expiresInSeconds <= 0
      ? PIX_DEFAULT_EXPIRY_SECONDS
      : PIX_MAX_EXPIRES_IN_SECONDS;
  const rewritten = buildEnvelope({
    kind: envelope.kind,
    payload: { ...payload, expiresInSeconds: clamped },
    actor: envelope.actor,
    taint: envelope.taint,
    createdAt: envelope.createdAt,
  });
  return decisionRewrite(
    rewritten,
    `expiresInSeconds clamped to ${clamped}.`,
    [
      basis("business", BASIS_CODES.business.QUANTITY_CAPPED, {
        field: "expiresInSeconds",
        requested: payload.expiresInSeconds,
        cappedTo: clamped,
      }),
    ],
  );
};

/**
 * REFUSE: `pix.charge.confirm` on a charge the system doesn't know about.
 * Resilient to replayed webhooks for purged charges.
 */
const requireKnownCharge: PixGuard = (envelope, state) => {
  if (envelope.kind !== "pix.charge.confirm" && envelope.kind !== "pix.charge.refund") {
    return null;
  }
  if (state.charge) return null;
  const payload = envelope.payload as { readonly chargeId: string };
  return decisionRefuse(refusePixChargeNotFound(payload.chargeId), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "charge_not_found",
      chargeId: payload.chargeId,
    }),
  ]);
};

/**
 * REFUSE: don't double-capture. If a confirm arrives for a charge
 * already in `captured`/`refunded`/`partially_refunded`, the webhook
 * delivery is a duplicate; the ledger should suppress it but defending
 * here too makes the kernel honest under audit.
 */
const refuseAlreadyCapturedConfirm: PixGuard = (envelope, state) => {
  if (envelope.kind !== "pix.charge.confirm") return null;
  if (!state.charge) return null;
  const terminalCaptured = new Set([
    "captured",
    "refunded",
    "partially_refunded",
  ]);
  if (!terminalCaptured.has(state.charge.status)) return null;
  return decisionRefuse(refusePixChargeAlreadyCaptured(state.charge.id), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "already_captured",
      chargeId: state.charge.id,
      status: state.charge.status,
    }),
  ]);
};

/**
 * ESCALATE: a confirm landing on a `failed` charge can't be auto-handled.
 * A human reviews the provider event vs the local record before any
 * further action.
 */
const escalateFailedConfirm: PixGuard = (envelope, state) => {
  if (envelope.kind !== "pix.charge.confirm") return null;
  if (!state.charge) return null;
  if (state.charge.status !== "failed") return null;
  return decisionEscalate(
    "human",
    "Confirm event arrived for a charge already marked failed; manual review required.",
    [
      basis("state", BASIS_CODES.state.TERMINAL_STATE, {
        reason: "confirm_on_failed_charge",
        chargeId: state.charge.id,
      }),
    ],
  );
};

/**
 * REFUSE: refunding a charge that hasn't been captured is meaningless.
 */
const refuseRefundBeforeCapture: PixGuard = (envelope, state) => {
  if (envelope.kind !== "pix.charge.refund") return null;
  if (!state.charge) return null;
  if (state.charge.capturedAt !== null) return null;
  return decisionRefuse(refusePixRefundUncapturedCharge(state.charge.id), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "refund_before_capture",
      chargeId: state.charge.id,
      status: state.charge.status,
    }),
  ]);
};

/**
 * DEFER: `pix.charge.confirm` arrives before the charge has settled
 * server-side (race between webhook variants, or a manual confirm).
 * Park the envelope; the resume path re-enters adjudication once the
 * settled webhook lands.
 */
const deferOnPendingConfirm: PixGuard = createPixPendingDeferGuard<PixChargeState>({
  readPaymentMethod: (state) => (state.charge ? "pix" : null),
  readPaymentStatus: (state) => state.charge?.status ?? null,
  matchesIntent: (kind) => kind === "pix.charge.confirm",
});

// ── Business guards ─────────────────────────────────────────────────────────

const requireValidAmount: PixGuard = (envelope) => {
  if (envelope.kind !== "pix.charge.create") return null;
  const payload = envelope.payload as PixChargeCreatePayload;
  if (
    Number.isInteger(payload.amountCentavos) &&
    payload.amountCentavos > 0
  ) {
    return null;
  }
  return decisionRefuse(refusePixAmountInvalid(payload.amountCentavos), [
    basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
      field: "amountCentavos",
      received: payload.amountCentavos,
    }),
  ]);
};

const requireRateLimit: PixGuard = (envelope, state) => {
  if (envelope.kind !== "pix.charge.create") return null;
  if (!state.rateLimit) return null;
  const { count, maxPerWindow } = state.rateLimit;
  if (count < maxPerWindow) return null;
  return decisionRefuse(refusePixRateLimitExceeded(count, maxPerWindow), [
    basis("business", BASIS_CODES.business.RULE_VIOLATED, {
      reason: "create_rate_limit",
      count,
      cap: maxPerWindow,
    }),
  ]);
};

const requireRefundWithinCapture: PixGuard = (envelope, state) => {
  if (envelope.kind !== "pix.charge.refund") return null;
  if (!state.charge || state.charge.capturedAt === null) return null;
  const payload = envelope.payload as PixChargeRefundPayload;
  const remaining =
    state.charge.amountCentavos - state.charge.refundedAmountCentavos;
  if (payload.amountCentavos <= remaining) return null;
  return decisionRefuse(
    refusePixRefundExceedsCapture(payload.amountCentavos, remaining),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "refund_exceeds_capture",
        chargeId: state.charge.id,
        requested: payload.amountCentavos,
        remaining,
      }),
    ],
  );
};

/**
 * REQUEST_CONFIRMATION: refunds at or above the configured threshold
 * surface a re-confirm prompt to the operator. Keeps high-value
 * refunds intentional.
 */
const requestConfirmationForLargeRefund: PixGuard = (envelope, state) => {
  if (envelope.kind !== "pix.charge.refund") return null;
  if (!state.charge) return null;
  const payload = envelope.payload as PixChargeRefundPayload;
  if (payload.amountCentavos < PIX_REFUND_CONFIRMATION_THRESHOLD_CENTAVOS) {
    return null;
  }
  return decisionRequestConfirmation(
    `Confirmar reembolso de R$ ${(payload.amountCentavos / 100).toFixed(2)} para a cobrança ${state.charge.id}?`,
    [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "refund_high_value_confirmation",
        threshold: PIX_REFUND_CONFIRMATION_THRESHOLD_CENTAVOS,
        amountCentavos: payload.amountCentavos,
      }),
    ],
  );
};

// ── PolicyBundle ────────────────────────────────────────────────────────────

/**
 * Order matters: state guards before business guards (kernel-fixed
 * order), and within each list the more-specific REFUSE/ESCALATE
 * guards run before the catch-all DEFER. The DEFER guard fires only
 * when no upstream guard has refused or escalated — that's how we
 * avoid parking envelopes that should have been refused outright.
 */
export const pixPaymentsPolicyBundle: PolicyBundle<
  PixChargeIntentKind,
  unknown,
  PixChargeState
> = {
  stateGuards: [
    clampExpiresIn,
    requireKnownCharge,
    refuseAlreadyCapturedConfirm,
    escalateFailedConfirm,
    refuseRefundBeforeCapture,
    deferOnPendingConfirm,
  ],
  authGuards: [],
  taint: pixPaymentsTaintPolicy,
  business: [
    requireValidAmount,
    requireRateLimit,
    requireRefundWithinCapture,
    requestConfirmationForLargeRefund,
  ],
  default: "REFUSE",
};
