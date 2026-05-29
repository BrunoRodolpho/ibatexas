/**
 * @ibatexas/pack-customer-onboarding — first-party Pack for the
 * customer-identity lifecycle domain.
 *
 * Fourth first-party Pack after `@ibatexas/pack-orders` (task 08),
 * `@ibatexas/pack-reservations` (task 09), and `@ibatexas/pack-whatsapp`
 * (task 10). Adds policy coverage for account create (SYSTEM-only),
 * profile / preferences / address / PIX-details updates, and the
 * LGPD Art. 18 anonymize flow with 24h grace via DEFER. Follows the
 * `pack-reservations` template per CLAUDE.md rule #9 / ADR #13.
 *
 * # Adoption patterns
 *
 *   1. Canonical-Pack-intent (recommended): import
 *      `customerOnboardingPack`, dispatch envelopes against
 *      `customerOnboardingPack.policy`. The Pack's intent kinds
 *      (`customer.profile.update`, `customer.preferences.update`,
 *      `customer.anonymize`, …) are the wire contract; the master
 *      taxonomy at `docs/adjudicate-migration/governance/
 *      01-intent-taxonomy.md` §"Domain: customer" is authoritative.
 *
 *   2. Bundle-only: import `customerOnboardingPolicyBundle` and feed
 *      to `adjudicate()` directly. Task 15's `CustomerCommandService`
 *      uses this pattern to wrap the existing
 *      `packages/domain/src/services/customer.service.ts` calls.
 *
 * # LGPD destructive-flow lighthouse
 *
 * This Pack is the canonical reference for the DEFER + 24h grace +
 * cancel-intent pattern that future destructive operations (e.g.,
 * order force-cancel, payment refund above threshold) will reuse.
 * Task 14's HTTP routes consume the DEFER decision; the OTP gate
 * (`<300s freshness`) and the grace resolver live there. This Pack
 * provides only the policy bundle.
 *
 * # Conformance
 *
 * `customerOnboardingPack satisfies PackV0<...>`. The
 * `__tests__/conformance.test.ts` corpus pins behaviour;
 * `runConformance(customerOnboardingPack)` from
 * `@adjudicate/conformance` runs the kernel-level invariant suite
 * (taint protection, replay determinism, basis-vocabulary purity,
 * guard ordering, default polarity). The dedicated
 * `__tests__/lgpd-anonymize.test.ts` covers the destructive lifecycle
 * (DEFER → cancel → re-issue → idempotency).
 */

import type { PackV0 } from "@adjudicate/core"
import { customerOnboardingCapabilityPlanner } from "./capabilities.js"
import { customerOnboardingPolicyBundle } from "./policies.js"
import { CUSTOMER_ANONYMIZE_GRACE_SIGNAL } from "./signals.js"
import type {
  CustomerOnboardingContext,
  CustomerOnboardingIntentKind,
  CustomerOnboardingPayload,
  CustomerOnboardingState,
} from "./types.js"

// ── Rehydrator ──────────────────────────────────────────────────────────

/**
 * Reconstitute a `CustomerOnboardingState` from a JSON-serializable
 * representation.
 *
 * The `now` field inside `ctx` doesn't survive `JSON.stringify` — it
 * comes back as an ISO string. This rehydrator promotes it back to
 * `Date`. The `parkedAnonymizeAt` / `lastProfileUpdateAt` fields are
 * epoch-ms numbers (not `Date`) so they round-trip as-is. All other
 * fields pass through.
 *
 * Permissive on input per the `PackV0.rehydrateState` convention:
 * malformed/missing fields fall back to empty defaults so scenario
 * fixtures and audit-replay payloads can be lenient while the
 * policy's guards remain the authoritative validators.
 */
export function rehydrateCustomerOnboardingState(
  raw: unknown,
): CustomerOnboardingState {
  const defaultState: CustomerOnboardingState = {
    ctx: {
      actor: { principal: "user" },
      customerExists: false,
      isAuthenticated: false,
      otpFresh: false,
      hasParkedAnonymize: false,
    },
  }
  if (typeof raw !== "object" || raw === null || !("ctx" in raw)) {
    return defaultState
  }
  const ctxRaw = (raw as { ctx: unknown }).ctx
  if (typeof ctxRaw !== "object" || ctxRaw === null) {
    return defaultState
  }
  const ctx = ctxRaw as CustomerOnboardingState["ctx"] & { now?: unknown }

  const toDate = (value: unknown): Date | null => {
    if (value instanceof Date) return value
    if (typeof value === "string" || typeof value === "number") {
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? null : d
    }
    return null
  }

  return {
    ...((raw as object) || {}),
    ctx: {
      ...ctx,
      now: toDate(ctx.now),
    },
  } as CustomerOnboardingState
}

// ── Re-exports for adopter convenience ──────────────────────────────────

export {
  CUSTOMER_ANONYMIZE_GRACE_HOURS,
  CUSTOMER_PROFILE_RATE_LIMIT_HOURS,
  CUSTOMER_OTP_FRESHNESS_SECONDS,
  customerOnboardingTaintPolicy,
  type CustomerAddressAddPayload,
  type CustomerAddressPayload,
  type CustomerAddressRemovePayload,
  type CustomerAnonymizeCancelPayload,
  type CustomerAnonymizePayload,
  type CustomerCreatePayload,
  type CustomerOnboardingContext,
  type CustomerOnboardingIntentKind,
  type CustomerOnboardingPayload,
  type CustomerOnboardingState,
  type CustomerPixDetailsSavePayload,
  type CustomerPreferencesUpdatePayload,
  type CustomerProfileUpdatePayload,
} from "./types.js"

export {
  CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
  type CustomerOnboardingSignal,
} from "./signals.js"

export {
  refuseAllergenInferred,
  refuseAnonymizeAlreadyPending,
  refuseAnonymizeCancelSupersedesParked,
  refuseAnonymizeNoParkedDeletion,
  refuseCpfInvalid,
  refuseCustomerNotFound,
  refuseDefault,
  refuseNotAuthenticated,
  refuseOtpStale,
  refuseProfileRateLimit,
  portugueseRefusalMessages,
} from "./refusals.js"

export { customerOnboardingPolicyBundle } from "./policies.js"

export {
  CUSTOMER_ONBOARDING_TOOL_TO_INTENT,
  CUSTOMER_ONBOARDING_TOOLS,
  customerOnboardingCapabilityPlanner,
} from "./capabilities.js"

/**
 * The Pack as a `PackV0`-conformant value. The `satisfies` clause
 * provides compile-time conformance — drift from `PackV0`'s shape
 * fails the build. `intents` stays narrowly typed via the explicit
 * type parameters; the master taxonomy (governance §"Domain: customer")
 * is the source of truth.
 *
 * Pack id convention matches sibling Packs (`ibatexas/pack-orders`,
 * `ibatexas/pack-reservations`, `ibatexas/pack-whatsapp`): short, no
 * scope prefix on the `id` field itself; the npm scope lives in
 * `package.json` only.
 */
export const customerOnboardingPack = {
  id: "ibatexas/pack-customer-onboarding",
  version: "1.0.0",
  contract: "v0",
  intents: [
    "customer.create",
    "customer.profile.update",
    "customer.preferences.update",
    "customer.pix.details.save",
    "customer.address.add",
    "customer.address.remove",
    "customer.anonymize",
    "customer.anonymize.cancel",
  ],
  policy: customerOnboardingPolicyBundle,
  planner: customerOnboardingCapabilityPlanner,
  /**
   * Refusal codes the Pack's policy may emit. The M3 AaC drift check
   * (`assertPackConformance` + `withBasisAudit`) verifies that
   * runtime emissions stay inside this set; new code added in
   * `refusals.ts` MUST be added here too.
   */
  basisCodes: [
    "auth.required",
    "customer.otp.stale",
    "customer.not_found",
    "customer.anonymize.already_pending",
    "customer.anonymize.no_parked_deletion",
    "customer.anonymize.cancel_supersedes_parked",
    "customer.allergens.must_be_explicit",
    "customer.profile.rate_limit",
    "customer.cpf.invalid_format",
    "customer.default.deny",
  ],
  /**
   * DEFER signal vocabulary. The Pack parks `customer.anonymize` on
   * `customer.anonymize.confirmed_after_grace` via the composed
   * `createStateDeferGuard` factory. `@adjudicate/conformance`'s
   * AC-004 invariant check verifies that every DEFER decision the
   * policy emits carries a signal from this list.
   */
  signals: [CUSTOMER_ANONYMIZE_GRACE_SIGNAL],
  rehydrateState: rehydrateCustomerOnboardingState,
} as const satisfies PackV0<
  CustomerOnboardingIntentKind,
  CustomerOnboardingPayload,
  CustomerOnboardingState,
  CustomerOnboardingContext
>
