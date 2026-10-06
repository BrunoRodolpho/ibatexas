/**
 * @ibatexas/pack-customer-onboarding — domain types.
 *
 * IbateXas's fourth first-party Pack: governs the customer-identity
 * lifecycle (account create, profile / preferences / address / PIX
 * details updates) plus the LGPD Art. 18 anonymize flow with a 24h
 * grace window via DEFER. Mirrors the `pack-reservations` layout so
 * subsequent Packs keep templating off the same shape.
 *
 * Authoritative intent vocabulary:
 * `docs/adjudicate-migration/governance/01-intent-taxonomy.md`
 * §"Domain: customer". The kinds enumerated here track that taxonomy
 * exactly — if a new kind appears in
 * `packages/domain/src/services/customer.service.ts` or in a future
 * customer-facing route, update the taxonomy doc FIRST.
 *
 * # Intent surface (governance §"customer")
 *
 *   - customer.create             — SYSTEM-only. Seeded by the OTP flow
 *                                    after Twilio Verify success; the LLM
 *                                    must never be able to forge a new
 *                                    customer record.
 *   - customer.profile.update     — UNTRUSTED. Name + email; rate-limited
 *                                    per `CUSTOMER_PROFILE_RATE_LIMIT_HOURS`
 *                                    to deter takeover-via-rapid-update.
 *   - customer.preferences.update — UNTRUSTED. Allergens are
 *                                    safety-critical; the policy enforces
 *                                    that `allergenExclusions` is an
 *                                    explicit array (CLAUDE.md rule #1).
 *   - customer.pix.details.save   — UNTRUSTED. PIX billing PII (name,
 *                                    email, CPF); the policy validates
 *                                    CPF *shape* only — the audit
 *                                    redactor (task 18) handles the
 *                                    PII redaction before the audit sink.
 *   - customer.address.add        — UNTRUSTED. Customer-owned address.
 *   - customer.address.remove     — UNTRUSTED. Ownership enforced by
 *                                    auth + state guards.
 *   - customer.anonymize          — UNTRUSTED. Destructive — DEFERs for
 *                                    `CUSTOMER_ANONYMIZE_GRACE_HOURS` (24h
 *                                    default) before the route layer
 *                                    actually anonymizes.
 *   - customer.anonymize.cancel   — UNTRUSTED. REFUSE-supersedes-parked
 *                                    semantics: clears the parked
 *                                    anonymize receipt (task 14 wires the
 *                                    Redis clear; the audit record carries
 *                                    `supersedes: [parked.intentHash]`).
 *
 * # Out of scope (separate Packs)
 *
 *   - `customer.session.*`        — authentication / JWT lifecycle
 *   - `customer.loyalty.*`        — loyalty + redemption
 *   - `customer.welcome_credit.*` — promotional credit
 *
 * # Source of existing logic
 *
 * `packages/domain/src/services/customer.service.ts` carries the
 * imperative implementation today (notably `anonymizeCustomer` at :233,
 * `upsertFromPhone` at :18, `updatePixDetails` at :148, preferences
 * upsert at :49). This Pack extracts the *policy* layer (taint, auth,
 * rate-limit, safety, LGPD grace) without re-implementing the side
 * effects — task 15's `CustomerCommandService` will consume the Pack's
 * adjudication and dispatch to the existing service methods.
 */

import { createSystemTaintPolicy } from "@adjudicate/primitives"

export type CustomerOnboardingIntentKind =
  // ═══ GENERATED — regenerate via `pnpm --filter @ibatexas/packs-composed run regen:intent-kinds` after editing packages/catalog/src/capability-definitions/definitions.ts. DO NOT HAND-EDIT BELOW THIS LINE. ═══
  | "customer.create"
  | "customer.profile.update"
  | "customer.preferences.update"
  | "customer.pix.details.save"
  | "customer.address.add"
  | "customer.address.remove"
  | "customer.anonymize"
  | "customer.anonymize.cancel"
  // ═══ END GENERATED REGION ═══

// ── Payloads ────────────────────────────────────────────────────────────

/**
 * `customer.create` is system-only — the OTP flow + Twilio Verify
 * webhook hydrates this kind. `source` discriminates the seed origin so
 * downstream analytics can split "first contact via OTP" vs the
 * pre-verified WhatsApp inbound (`upsertFromWhatsApp` at
 * `customer.service.ts:172`).
 */
export interface CustomerCreatePayload {
  readonly phoneHash: string
  readonly source: "otp" | "wa-auto"
}

export interface CustomerProfileUpdatePayload {
  readonly name?: string
  readonly email?: string
}

/**
 * `allergenExclusions` MUST be an explicit array (CLAUDE.md rule #1).
 * The policy refuses if it's absent or inferred from prose — allergens
 * are safety-critical and the LLM cannot guess them. Empty array `[]`
 * is the canonical "no exclusions" shape and is accepted as-is.
 *
 * `favoriteCategories` is non-safety-critical preference metadata
 * (category handles like "churrasco", "grelhados"); kept on the payload
 * so the executor can persist it as part of the same envelope rather
 * than threading a separate side-channel through `extras`.
 */
export interface CustomerPreferencesUpdatePayload {
  readonly allergenExclusions: ReadonlyArray<string>
  readonly dietaryFlags?: ReadonlyArray<string>
  readonly favoriteCategories?: ReadonlyArray<string>
}

/**
 * PIX billing details (`updatePixDetails` at `customer.service.ts:148`).
 * `cpf` MUST be 11 digits + valid Brazilian checksum. The Pack's policy
 * validates shape only — the audit redactor (task 18) hashes/redacts
 * `name`, `email`, and `cpf` before the audit sink so the policy never
 * touches raw PII at decision time.
 */
export interface CustomerPixDetailsSavePayload {
  readonly name: string
  readonly email: string
  /**
   * audit-2026-05-25 (I10): optional. Customers who pay via PIX without
   * entering a CPF (guest-style WhatsApp checkout origin) previously
   * triggered the validateCpfShape REFUSE on an empty-string fallback,
   * which dropped name + email persistence too. The CPF-shape policy
   * now skips validation when cpf is absent/empty; presence still
   * triggers Modulo-11 validation.
   */
  readonly cpf?: string
}

export interface CustomerAddressPayload {
  readonly label?: string
  readonly street: string
  readonly number?: string
  readonly complement?: string
  readonly neighborhood?: string
  readonly city: string
  readonly state: string
  readonly zip: string
}

export interface CustomerAddressAddPayload {
  readonly address: CustomerAddressPayload
}

export interface CustomerAddressRemovePayload {
  readonly addressId: string
}

/**
 * The destructive flow — irreversible by definition. The Pack DEFERs on
 * `customer.anonymize.confirmed_after_grace` with a 24h timeout
 * (configurable). `scope: "lgpd_art_18"` is the legal anchor (Brazilian
 * LGPD Art. 18 — "direito ao apagamento"); the constant lives in the
 * payload so the audit record can subpoena-friendly reference it.
 *
 * `otpToken` is consumed by the route layer (task 14) to assert OTP
 * freshness BEFORE building the envelope — the Pack inspects only the
 * `state.otpFresh` boolean projected from that check.
 */
export interface CustomerAnonymizePayload {
  readonly customerId: string
  readonly otpToken: string
  readonly scope: "lgpd_art_18"
}

export interface CustomerAnonymizeCancelPayload {
  readonly customerId: string
}

/**
 * Discriminated payload union — typed by `kind`. Guards narrow via
 * `envelope.kind` and may cast `envelope.payload` to the matching
 * member; payload contracts are validated by the guards in
 * `./policies.ts` and by the wire schema upstream.
 */
export type CustomerOnboardingPayload =
  | CustomerCreatePayload
  | CustomerProfileUpdatePayload
  | CustomerPreferencesUpdatePayload
  | CustomerPixDetailsSavePayload
  | CustomerAddressAddPayload
  | CustomerAddressRemovePayload
  | CustomerAnonymizePayload
  | CustomerAnonymizeCancelPayload

// ── Context (per-turn caller identity / channel surface) ────────────────

/**
 * Per-turn context the planner consumes. Structurally independent from
 * `OrderContext` / `ReservationContext` so the planner here doesn't
 * accidentally couple to a sibling domain.
 *
 * `redisRk` is the `rk()` builder from `@ibatexas/tools` (CLAUDE.md
 * rule #7); the Pack accepts it as a context function so adopters can
 * compose Redis-aware checks downstream without the Pack depending on
 * the IbateXas tools package directly. The Pack itself does not call
 * Redis at decision time — `state.hasParkedAnonymize` is projected by
 * the adopter command service from the receipt lookup.
 */
export interface CustomerOnboardingContext {
  readonly actor: {
    readonly principal: "user" | "system" | "staff"
    readonly id?: string
  }
  readonly redisRk?: (template: string, ...args: string[]) => string
}

// ── State (per-session snapshot the kernel adjudicates against) ─────────

/**
 * Per-session state the Pack's policies inspect. Adopters embed this
 * into their session context shape. Fields here track exactly what
 * `customer.service.ts` (and the task-14 routes) read off the DB +
 * Redis at decision time — the Pack does not pull from Prisma or
 * Redis directly, the adopter projects state in.
 *
 * # Identity fields
 *   - `customerId`        the principal's id (absent for `customer.create`).
 *   - `customerExists`    true if the principal id resolves to a row.
 *   - `isAuthenticated`   has a verified session (post-OTP).
 *   - `otpFresh`          <300s since last OTP verification. Required by
 *                         `customer.anonymize` + `customer.anonymize.cancel`
 *                         per investigation 08 P0 #2.
 *
 * # LGPD anonymize lifecycle fields
 *   - `hasParkedAnonymize` true if `rk('anonymize:pending:{customerId}')`
 *                          exists in Redis. The adopter projects this
 *                          boolean; the receipt itself stays out of the
 *                          policy's surface.
 *   - `parkedAnonymizeAt`  epoch ms when the DEFER was parked, used by
 *                          audit + analytics. Optional — only present
 *                          when `hasParkedAnonymize === true`.
 *
 * # Rate-limit field
 *   - `lastProfileUpdateAt` epoch ms of the most-recent profile update.
 *                           The rate-limit guard compares against
 *                           `CUSTOMER_PROFILE_RATE_LIMIT_HOURS` * 3600 *
 *                           1000.
 */
export interface CustomerOnboardingState {
  readonly ctx: CustomerOnboardingContext & {
    /** Tenant this request operates on (AuthReviewer-009 / RC-A1 D-12). Single-tenant
     *  today; the `requireTenantBinding` authGuard REFUSEs a mismatch, no-op when absent. */
    readonly tenantId?: string
    /** Wall-clock snapshot. Required for time-comparison guards. */
    readonly now?: Date | null
    readonly customerId?: string | null
    readonly customerExists: boolean
    readonly isAuthenticated: boolean
    readonly otpFresh: boolean
    readonly hasParkedAnonymize: boolean
    readonly parkedAnonymizeAt?: number | null
    readonly lastProfileUpdateAt?: number | null
    /**
     * Immediate-erasure mode (RC-A1 cutover D-25, LGPD Option B). When the
     * AUTHENTICATED HTTP route `DELETE /api/me/data` requests erasure, it sets this
     * so `customer.anonymize` EXECUTEs immediately — skipping the fresh-OTP check and
     * the 24h-grace DEFER — to stay byte-equivalent to today's session-only immediate
     * anonymize. SAFE: `requireAuthenticated` still gates anonymize on
     * `isAuthenticated`, and the cognitive-loop state is unauthenticated, so the LLM
     * path can never reach immediate erasure even if this leaked. Absent/false ⇒ the
     * cognitive-loop OTP + 24h-grace flow is preserved unchanged.
     */
    readonly immediateErasure?: boolean
  }
}

// ── Taint policy ────────────────────────────────────────────────────────

/**
 * `customer.create` is the canonical example of a SYSTEM-only kind in
 * this domain — only the OTP-verify completion hook (task 14) may emit
 * it, with SYSTEM taint per the master plan §"Governance principles".
 * Every other customer-identity kind tolerates UNTRUSTED (LLM-proposable
 * via the HTTP layer; the policy decides whether to honor).
 *
 * The `systemMinimum: "SYSTEM"` lift (above the default `"TRUSTED"`)
 * is intentional: `customer.create` MUST come from the OTP-verify
 * completion hook, never from an LLM tool call OR an in-process
 * service-account replay. Only the SYSTEM-rank seed path qualifies.
 */
export const customerOnboardingTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: ["customer.create"],
  userMinimum: "UNTRUSTED",
  systemMinimum: "SYSTEM",
})

// ── Business thresholds (env-driven; CLAUDE.md rule #3) ─────────────────

function readPositiveNumber(
  envValue: string | undefined,
  fallback: number,
): number {
  if (envValue === undefined || envValue === "") return fallback
  const n = Number.parseFloat(envValue)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/**
 * Grace window between `customer.anonymize` DEFER and the route layer
 * actually anonymizing. 24h default per LGPD Art. 18 customary practice
 * (Brazilian DPA guidance); operators override via
 * `CUSTOMER_ANONYMIZE_GRACE_HOURS`. Centavos do not apply here — the
 * unit is hours.
 */
export const CUSTOMER_ANONYMIZE_GRACE_HOURS = readPositiveNumber(
  process.env.CUSTOMER_ANONYMIZE_GRACE_HOURS,
  24,
)

/**
 * Cool-down between profile updates. 1h default — long enough to deter
 * a takeover-via-rapid-update attack (attacker changes name then email
 * within the same session window) without blocking legitimate
 * corrections. Override via `CUSTOMER_PROFILE_RATE_LIMIT_HOURS`.
 */
export const CUSTOMER_PROFILE_RATE_LIMIT_HOURS = readPositiveNumber(
  process.env.CUSTOMER_PROFILE_RATE_LIMIT_HOURS,
  1,
)

/**
 * OTP freshness window — kept here as a constant for documentation
 * purposes only. The actual <300s check lives in task 14's route layer;
 * the Pack inspects only the `state.otpFresh` boolean. Documenting the
 * window here gives the audit-replay path one place to subpoena.
 */
export const CUSTOMER_OTP_FRESHNESS_SECONDS = 300
