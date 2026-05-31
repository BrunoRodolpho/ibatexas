/**
 * @ibatexas/pack-customer-onboarding — PolicyBundle.
 *
 * Composed from `@adjudicate/primitives` factories
 * (`createSystemTaintPolicy`, `createStateDeferGuard`). Default polarity
 * is REFUSE — per master plan §"Governance principles" #4 and
 * `governance/04-decision-policy.md` §"Default refuse policy".
 *
 * Guard ordering inside each phase matters. The kernel evaluation order
 * is `state → taint → auth → business` (ADR-104). The state phase here
 * carries the customer-existence check (so a missing principal short-
 * circuits before any auth side-effect) and the anonymize idempotency
 * + OTP-freshness checks. The DEFER guard for `customer.anonymize` is
 * the LAST business guard so the in-flight checks (otpFresh,
 * !hasParkedAnonymize) gate it.
 *
 * # Migrated behaviour
 *
 * The imperative logic in
 * `packages/domain/src/services/customer.service.ts` (preferences
 * upsert at :49, PIX-details update at :148, anonymize at :233) is
 * kept as-is — this Pack adds the *policy* envelope around it. Task 14
 * ships the HTTP routes that build envelopes for these kinds; task 15
 * wires the Pack into `CustomerCommandService` to wrap the existing
 * service calls.
 */

import {
  basis,
  BASIS_CODES,
  decisionExecute,
  decisionRefuse,
} from "@adjudicate/core"
import {
  nameGuard,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createStateDeferGuard } from "@adjudicate/primitives"
import { CUSTOMER_ANONYMIZE_GRACE_SIGNAL } from "./signals.js"
import {
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
} from "./refusals.js"
import {
  CUSTOMER_ANONYMIZE_GRACE_HOURS,
  CUSTOMER_PROFILE_RATE_LIMIT_HOURS,
  customerOnboardingTaintPolicy,
  type CustomerOnboardingIntentKind,
  type CustomerOnboardingPayload,
  type CustomerOnboardingState,
} from "./types.js"

type CustomerGuard = Guard<
  CustomerOnboardingIntentKind,
  CustomerOnboardingPayload,
  CustomerOnboardingState
>

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Kinds for which the customer principal must already exist in the DB.
 * `customer.create` is excluded — it's the kind that CREATES the
 * principal. Every other kind in this Pack mutates an existing customer.
 */
const KINDS_REQUIRING_EXISTING_CUSTOMER: ReadonlySet<CustomerOnboardingIntentKind> =
  new Set([
    "customer.profile.update",
    "customer.preferences.update",
    "customer.pix.details.save",
    "customer.address.add",
    "customer.address.remove",
    "customer.anonymize",
    "customer.anonymize.cancel",
  ])

/**
 * Customer-actor kinds that require an authenticated session. Same set
 * minus `customer.create` (which is system-actor, taint-gated).
 */
const KINDS_REQUIRING_AUTHENTICATED_CUSTOMER: ReadonlySet<CustomerOnboardingIntentKind> =
  new Set([
    "customer.profile.update",
    "customer.preferences.update",
    "customer.pix.details.save",
    "customer.address.add",
    "customer.address.remove",
    "customer.anonymize",
    "customer.anonymize.cancel",
  ])

/**
 * Anonymize-related kinds require a fresh OTP verification (per
 * investigation 08 P0 #2). The OTP itself is verified upstream; the
 * Pack checks only the `state.otpFresh` boolean projected by the
 * adopter command service.
 */
const KINDS_REQUIRING_FRESH_OTP: ReadonlySet<CustomerOnboardingIntentKind> =
  new Set(["customer.anonymize", "customer.anonymize.cancel"])

/**
 * CPF validator — 11 digits with the two-digit checksum from
 * `receita federal` Modulo-11 spec. Brazilian CPF format:
 *   1. Strip non-digits; assert 11 characters.
 *   2. Reject sequences of identical digits (00000000000, …, 99999999999)
 *      which pass the modulo check but are administratively invalid.
 *   3. First check digit: sum(d[0..8] * (10..2)) mod 11; if rem < 2 → 0,
 *      else 11 - rem.
 *   4. Second check digit: sum(d[0..9] * (11..2)) mod 11; if rem < 2 → 0,
 *      else 11 - rem.
 *
 * The Pack does not store or log the CPF value; this function is the
 * shape gate only. Audit redaction (task 18) is the authority for
 * hashing the raw value out of the audit record.
 */
function isValidCpf(raw: string): boolean {
  const digits = raw.replace(/\D/g, "")
  if (digits.length !== 11) return false
  if (/^(\d)\1{10}$/.test(digits)) return false

  const d = digits.split("").map((c) => Number.parseInt(c, 10))

  let sum1 = 0
  for (let i = 0; i < 9; i += 1) sum1 += d[i]! * (10 - i)
  let check1 = (sum1 * 10) % 11
  if (check1 === 10) check1 = 0
  if (check1 !== d[9]) return false

  let sum2 = 0
  for (let i = 0; i < 10; i += 1) sum2 += d[i]! * (11 - i)
  let check2 = (sum2 * 10) % 11
  if (check2 === 10) check2 = 0
  if (check2 !== d[10]) return false

  return true
}

/**
 * Hours elapsed since `lastProfileUpdateAt`. Returns `null` when the
 * `now` or `lastProfileUpdateAt` field is missing — the rate-limit
 * guard treats null as "no signal, let the request through".
 */
function hoursSinceLastProfileUpdate(
  state: CustomerOnboardingState,
): number | null {
  const now = state.ctx.now
  const last = state.ctx.lastProfileUpdateAt
  if (!now || last === undefined || last === null) return null
  return (now.getTime() - last) / (1000 * 60 * 60)
}

// ── Auth guards ─────────────────────────────────────────────────────────

/**
 * Customer-actor kinds require `state.isAuthenticated === true`. The
 * `customer.create` kind bypasses (handled by the taint policy as
 * SYSTEM-only).
 */
const requireAuthenticated: CustomerGuard = (envelope, state) => {
  if (!KINDS_REQUIRING_AUTHENTICATED_CUSTOMER.has(envelope.kind)) return null
  if (state.ctx.isAuthenticated) return null
  return decisionRefuse(refuseNotAuthenticated(), [
    basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, {
      reason: "not_authenticated",
      kind: envelope.kind,
    }),
  ])
}

// ── State guards ────────────────────────────────────────────────────────

/**
 * Customer must exist in the DB for every kind except
 * `customer.create`. The taint policy already gates `customer.create`
 * to SYSTEM-only; we don't double-check existence here because the
 * SYSTEM seed path is responsible for creating the row.
 */
const requireCustomerExists: CustomerGuard = (envelope, state) => {
  if (!KINDS_REQUIRING_EXISTING_CUSTOMER.has(envelope.kind)) return null
  if (state.ctx.customerExists) return null
  return decisionRefuse(refuseCustomerNotFound(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "customer_missing",
      kind: envelope.kind,
    }),
  ])
}

/**
 * Anonymize-related kinds require a fresh OTP verification. Per
 * investigation 08 P0 #2: a long-lived session token alone is not
 * sufficient to authorize destructive deletion — the user must have
 * just proven they hold the phone.
 */
const requireFreshOtp: CustomerGuard = (envelope, state) => {
  if (!KINDS_REQUIRING_FRESH_OTP.has(envelope.kind)) return null
  // Immediate erasure (authenticated HTTP DELETE /api/me/data, D-25 Option B) skips
  // fresh-OTP — preserves today's session-only immediate-anonymize behavior. The
  // cognitive-loop grace flow still requires fresh OTP (immediateErasure absent).
  // Safe: requireAuthenticated already gates this on isAuthenticated.
  if (state.ctx.immediateErasure === true) return null
  if (state.ctx.otpFresh) return null
  return decisionRefuse(refuseOtpStale(), [
    basis("auth", BASIS_CODES.auth.IDENTITY_EXPIRED, {
      reason: "otp_stale",
      kind: envelope.kind,
    }),
  ])
}

/**
 * Idempotency guard on `customer.anonymize`: refuse if a parked
 * anonymize already exists for this customer. Prevents double-DEFER
 * (and the resulting double-audit) when the user clicks "delete account"
 * twice within the grace window.
 */
const refuseAnonymizeIfAlreadyPending: CustomerGuard = (envelope, state) => {
  if (envelope.kind !== "customer.anonymize") return null
  if (!state.ctx.hasParkedAnonymize) return null
  return decisionRefuse(refuseAnonymizeAlreadyPending(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "anonymize_already_pending",
      parkedAt: state.ctx.parkedAnonymizeAt ?? null,
    }),
  ])
}

// ── Business guards ─────────────────────────────────────────────────────

/**
 * Allergen safety-critical guard. REFUSE if `allergenExclusions` is
 * not an explicit array. Empty array `[]` is fine — that's the
 * canonical "no exclusions" shape.
 *
 * CLAUDE.md rule #1: allergens are NEVER inferred. The LLM cannot guess
 * them from product names or prose; the user must affirmatively list
 * (or affirmatively clear) the array.
 */
const validateAllergenExplicitArray: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.preferences.update") return null
  const payload = envelope.payload as { allergenExclusions?: unknown }
  if (Array.isArray(payload.allergenExclusions)) return null
  return decisionRefuse(refuseAllergenInferred(), [
    basis("business", BASIS_CODES.business.RULE_VIOLATED, {
      rule: "allergens_must_be_explicit_array",
      seen: typeof payload.allergenExclusions,
    }),
  ])
}

/**
 * Rate-limit on `customer.profile.update`. REFUSE if the previous
 * update was within `CUSTOMER_PROFILE_RATE_LIMIT_HOURS`. Counters
 * takeover-via-rapid-update (attacker changes name then email then
 * removes the original phone, all within the same session window).
 *
 * If `now` or `lastProfileUpdateAt` is missing, the guard short-
 * circuits — first-update has no `lastProfileUpdateAt`, so the
 * comparison is meaningless.
 */
const enforceProfileRateLimit: CustomerGuard = (envelope, state) => {
  if (envelope.kind !== "customer.profile.update") return null
  const hoursSince = hoursSinceLastProfileUpdate(state)
  if (hoursSince === null) return null
  if (hoursSince >= CUSTOMER_PROFILE_RATE_LIMIT_HOURS) return null
  const remaining = CUSTOMER_PROFILE_RATE_LIMIT_HOURS - hoursSince
  return decisionRefuse(refuseProfileRateLimit(remaining), [
    basis("business", BASIS_CODES.business.RULE_VIOLATED, {
      rule: "profile_rate_limit",
      hoursSince,
      threshold: CUSTOMER_PROFILE_RATE_LIMIT_HOURS,
    }),
  ])
}

/**
 * CPF-shape guard on `customer.pix.details.save`. REFUSE if the CPF is
 * not 11 digits with a valid Modulo-11 checksum. The Pack does not log
 * the raw value; task 18's AuditRedactor handles the redaction before
 * the audit sink.
 */
const validateCpfShape: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.pix.details.save") return null
  const payload = envelope.payload as { cpf?: unknown }
  // audit-2026-05-25 (I10): skip validation when cpf is absent or empty.
  // Pre-fix the cachePixDetails envelope path at
  // packages/llm-provider/src/machine/actions.ts:415 supplied
  // `cpf: data.cpf ?? ""` to satisfy a previously-non-optional payload
  // shape. validateCpfShape ran `isValidCpf("")` → false → REFUSE,
  // which blocked name + email persistence for every guest-style PIX
  // checkout. CustomerPixDetailsSavePayload.cpf is now optional; this
  // guard treats absence as "nothing to validate, let the upstream
  // executor handle name/email persistence." Presence still triggers
  // Modulo-11 validation.
  if (typeof payload.cpf !== "string" || payload.cpf.length === 0) {
    return null
  }
  if (!isValidCpf(payload.cpf)) {
    return decisionRefuse(refuseCpfInvalid(), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "cpf_invalid_format",
      }),
    ])
  }
  return null
}

/**
 * Cancel-supersedes-parked branch of `customer.anonymize.cancel`. The
 * happy path: a parked anonymize exists; the cancel REFUSEs (clearing
 * the parked DEFER) with `cancel_supersedes_parked`. Task 14's route
 * layer consumes this code to clear the Redis receipt.
 *
 * Even though it returns a `REFUSE` Decision, this is the *success*
 * branch — the kernel emits the basis with `RULE_SATISFIED` so
 * downstream analytics can distinguish it from genuine failures.
 */
const handleAnonymizeCancelSupersedesParked: CustomerGuard = (
  envelope,
  state,
) => {
  if (envelope.kind !== "customer.anonymize.cancel") return null
  if (!state.ctx.hasParkedAnonymize) return null
  return decisionRefuse(refuseAnonymizeCancelSupersedesParked(), [
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      rule: "anonymize_cancel_supersedes_parked",
      parkedAt: state.ctx.parkedAnonymizeAt ?? null,
    }),
  ])
}

/**
 * No-parked-deletion branch of `customer.anonymize.cancel`. If there's
 * nothing to cancel, REFUSE with the dedicated code so the route layer
 * can return a graceful "nothing to cancel" message rather than
 * silently no-op.
 */
const handleAnonymizeCancelNoParked: CustomerGuard = (envelope, state) => {
  if (envelope.kind !== "customer.anonymize.cancel") return null
  if (state.ctx.hasParkedAnonymize) return null
  return decisionRefuse(refuseAnonymizeNoParkedDeletion(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "no_parked_deletion",
    }),
  ])
}

// ── DEFER on customer.anonymize.confirmed_after_grace ───────────────────

/**
 * The LGPD destructive-flow lighthouse. `customer.anonymize` DEFERs on
 * `customer.anonymize.confirmed_after_grace` with a 24h timeout. The
 * runtime resolver (task 14) fires the signal once the window elapses
 * without a corresponding `customer.anonymize.cancel`.
 *
 * Pre-conditions enforced by earlier guards (the `matches` predicate
 * here is intentionally narrow — kind-only — because the auth +
 * state + OTP-freshness + idempotency guards run BEFORE this guard in
 * the kernel evaluation order, so by the time we reach here all
 * conditions are satisfied):
 *   - `state.isAuthenticated === true` (requireAuthenticated)
 *   - `state.customerExists === true` (requireCustomerExists)
 *   - `state.otpFresh === true` (requireFreshOtp)
 *   - `state.hasParkedAnonymize === false`
 *     (refuseAnonymizeIfAlreadyPending)
 */
const anonymizeGraceDeferBase = createStateDeferGuard<
  CustomerOnboardingIntentKind,
  CustomerOnboardingPayload,
  CustomerOnboardingState
>({
  matches: (envelope) => envelope.kind === "customer.anonymize",
  signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
  timeoutMs: CUSTOMER_ANONYMIZE_GRACE_HOURS * 60 * 60 * 1000,
  basis: (envelope) => [
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      rule: "lgpd_art_18_grace",
      kind: envelope.kind,
      graceHours: CUSTOMER_ANONYMIZE_GRACE_HOURS,
    }),
  ],
})

/**
 * RC-A1 cutover D-25 (LGPD Option B): the authenticated immediate-erasure HTTP path
 * (DELETE /api/me/data) sets `state.ctx.immediateErasure` to skip the 24h grace DEFER
 * and anonymize NOW (byte-equivalent to today). The cognitive-loop flow leaves it
 * absent ⇒ the LGPD 24h-grace lighthouse is preserved unchanged.
 */
const deferAnonymizeForGrace = nameGuard(
  "deferAnonymizeForGrace",
  (envelope, state) => {
    if ((state as CustomerOnboardingState).ctx.immediateErasure === true) return null
    return anonymizeGraceDeferBase(envelope, state as CustomerOnboardingState)
  },
) as CustomerGuard

// ── EXECUTE producers (default is REFUSE; positive matches required) ────

/**
 * Each happy-path kind needs an explicit EXECUTE guard because the
 * Pack's default is REFUSE. The kernel's evaluation order means these
 * fire AFTER the state / auth / taint / business-refuse guards reject
 * the failing cases — and AFTER the DEFER guard so an in-flight
 * anonymize doesn't accidentally fall through to EXECUTE.
 *
 * The guards are intentionally narrow — one per intent kind — so the
 * audit basis carries the kind in a machine-readable form.
 */
const executeCreate: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.create") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

/**
 * RC-A1 cutover D-25: EXECUTE producer for `customer.anonymize`. It runs AFTER
 * `deferAnonymizeForGrace` in the business array, so the cognitive-loop grace flow
 * DEFERs and never reaches here; only the authenticated immediate-erasure HTTP path
 * (which set `state.ctx.immediateErasure` so the defer is skipped) falls through to
 * this EXECUTE — anonymize NOW, byte-equivalent to today's DELETE /api/me/data.
 */
const executeAnonymize: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.anonymize") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeProfileUpdate: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.profile.update") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executePreferencesUpdate: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.preferences.update") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executePixDetailsSave: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.pix.details.save") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeAddressAdd: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.address.add") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeAddressRemove: CustomerGuard = (envelope) => {
  if (envelope.kind !== "customer.address.remove") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

// ── PolicyBundle ────────────────────────────────────────────────────────

/**
 * The customer-domain PolicyBundle. Feed to `adjudicate()` from
 * `@adjudicate/core/kernel` to decide whether to execute a proposed
 * envelope. Default is REFUSE — any kind not covered by an explicit
 * EXECUTE guard is denied by construction.
 *
 * Phase order is fixed by the kernel: `state → taint → auth →
 * business → default`. Within each phase, guards run in declared
 * order; the FIRST non-null decision wins.
 *
 * # Guard ordering rationale
 *
 *   state:
 *     1. requireCustomerExists      — short-circuit for non-existent customer
 *     2. requireFreshOtp            — short-circuit destructive ops without OTP
 *     3. refuseAnonymizeIfAlreadyPending — idempotency before DEFER
 *
 *   auth:
 *     1. requireAuthenticated       — gate customer-actor kinds
 *
 *   taint: customerOnboardingTaintPolicy (customer.create system-only)
 *
 *   business:
 *     1. validateAllergenExplicitArray         — safety-critical first
 *     2. enforceProfileRateLimit               — takeover prevention
 *     3. validateCpfShape                      — PII shape gate
 *     4. handleAnonymizeCancelSupersedesParked — cancel happy path
 *     5. handleAnonymizeCancelNoParked         — cancel no-op path
 *     6. deferAnonymizeForGrace                — LGPD DEFER (after gates)
 *     7. executeCreate / executeProfileUpdate / … — EXECUTE producers
 */
export const customerOnboardingPolicyBundle: PolicyBundle<
  CustomerOnboardingIntentKind,
  CustomerOnboardingPayload,
  CustomerOnboardingState
> = {
  stateGuards: [
    requireCustomerExists,
    requireFreshOtp,
    refuseAnonymizeIfAlreadyPending,
  ],
  authGuards: [requireAuthenticated],
  taint: customerOnboardingTaintPolicy,
  business: [
    validateAllergenExplicitArray,
    enforceProfileRateLimit,
    validateCpfShape,
    handleAnonymizeCancelSupersedesParked,
    handleAnonymizeCancelNoParked,
    deferAnonymizeForGrace,
    executeAnonymize,
    executeCreate,
    executeProfileUpdate,
    executePreferencesUpdate,
    executePixDetailsSave,
    executeAddressAdd,
    executeAddressRemove,
  ],
  /**
   * Fail-safe per master plan §"Governance principles" #4 — an intent
   * that no positive guard matched is REFUSEd. The kernel emits the
   * generic `default_deny` refusal; the Pack does not override at the
   * bundle level (an explicit Pack-level fallback would have to be a
   * business guard returning `refuseDefault(...)`).
   */
  default: "REFUSE",
}

// ── Re-exports for adopter convenience ──────────────────────────────────

/**
 * `refuseDefault` re-exported in case adopters want to wrap their own
 * business guard with a richer fallback refusal. The bundle itself
 * leans on the kernel's `default_deny` (with the pt-BR locale from
 * `@adjudicate/locales-pt-br`).
 */
export { refuseDefault }
