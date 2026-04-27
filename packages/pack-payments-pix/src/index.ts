// @adjudicate/pack-payments-pix — public surface.
//
// Bundles every artifact an adopter wires into the kernel for the PIX
// charge lifecycle (create / confirm / refund). Companion docs:
// `README.md` and the 4-stage shadow→enforce runbook in
// `docs/ops/runbooks/05-stage-pix-charge-pack.md` (in the IbateXas
// reference deployment).
//
// For finer-grained imports during testing or composition, the
// individual modules export the same symbols.

export {
  PIX_CHARGE_INTENT_KINDS,
  PIX_CONFIRMATION_SIGNAL,
  PIX_CONFIRMED_STATUSES,
  PIX_DEFAULT_DEFER_TIMEOUT_MS,
  PIX_DEFAULT_EXPIRY_SECONDS,
  pixPaymentsTaintPolicy,
  type PixChargeConfirmPayload,
  type PixChargeCreatePayload,
  type PixChargeEnvelope,
  type PixChargeIntentKind,
  type PixChargeProviderStatus,
  type PixChargeRateLimitWindow,
  type PixChargeRecord,
  type PixChargeRefundPayload,
  type PixChargeState,
  type PixChargeStatus,
} from "./types.js";

export {
  refusePixAmountInvalid,
  refusePixChargeAlreadyCaptured,
  refusePixChargeExpired,
  refusePixChargeFailed,
  refusePixChargeNotFound,
  refusePixConfirmRequiresWebhook,
  refusePixRateLimitExceeded,
  refusePixRefundExceedsCapture,
  refusePixRefundUncapturedCharge,
} from "./refusals.js";

export {
  PIX_PAYMENTS_TOOLS,
  pixPaymentsCapabilityPlanner,
} from "./capabilities.js";

export {
  PIX_REFUND_CONFIRMATION_THRESHOLD_CENTAVOS,
  pixPaymentsPolicyBundle,
} from "./policies.js";

export {
  createPixPendingDeferGuard,
  type PixPendingDeferGuardOptions,
} from "./guards.js";

export { pixPaymentsPack } from "./pack.js";
