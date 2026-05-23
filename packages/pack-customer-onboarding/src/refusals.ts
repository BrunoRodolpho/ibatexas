/**
 * @ibatexas/pack-customer-onboarding — typed refusal helpers (pt-BR).
 *
 * Every refusal the Pack's policy emits flows through one of these
 * builders. The machine-readable `code` is stable — observability,
 * drift detection (M3 AaC review), and audit-record analytics key
 * off it. The user-facing text is pt-BR per CLAUDE.md rule #4 and is
 * the only place the strings live (no scattering).
 *
 * Codes follow the dotted convention prefixed by the Pack's domain
 * (`customer.*`), mirroring the `order.*` / `reservation.*` convention
 * in sibling first-party Packs.
 *
 * The pt-BR locale dictionary (`@adjudicate/locales-pt-BR.
 * portugueseRefusalMessages`) covers kernel-emitted codes
 * (`taint_level_insufficient`, `default_deny`, etc.); Pack-specific
 * codes ship their pt-BR userFacing here so a downstream
 * `localizeDecision()` call falls through to the embedded text rather
 * than the kernel fallback.
 */

import { refuse, type Refusal } from "@adjudicate/core"
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br"

// ── Auth refusals (AUTH) ────────────────────────────────────────────────

export function refuseNotAuthenticated(): Refusal {
  return refuse(
    "AUTH",
    "auth.required",
    "Preciso confirmar seu cadastro antes de continuar — me diz seu número de WhatsApp.",
  )
}

/**
 * OTP-staleness refusal — emitted on `customer.anonymize` and
 * `customer.anonymize.cancel` when `state.otpFresh === false`. The user
 * is prompted to re-run the OTP flow before retrying the destructive
 * action. Per investigation 08 P0 #2.
 */
export function refuseOtpStale(): Refusal {
  return refuse(
    "AUTH",
    "customer.otp.stale",
    "Sua verificação expirou. Solicite um novo código antes de continuar.",
  )
}

// ── State refusals (STATE) ──────────────────────────────────────────────

export function refuseCustomerNotFound(): Refusal {
  return refuse(
    "STATE",
    "customer.not_found",
    "Não encontrei seu cadastro. Verifique seu número de WhatsApp.",
  )
}

/**
 * Idempotency guard — emitted when `customer.anonymize` is proposed
 * while a parked DEFER already exists for the same customer. Avoids
 * double-parking and surfaces the active pending state to the caller.
 */
export function refuseAnonymizeAlreadyPending(): Refusal {
  return refuse(
    "STATE",
    "customer.anonymize.already_pending",
    "Já existe uma solicitação de exclusão em andamento. Aguarde 24h ou cancele a solicitação atual.",
  )
}

/**
 * Cancel guard with nothing to cancel — emitted when
 * `customer.anonymize.cancel` is proposed but no parked anonymize
 * exists. The route layer (task 14) discards the receipt unconditionally
 * in this branch.
 */
export function refuseAnonymizeNoParkedDeletion(): Refusal {
  return refuse(
    "STATE",
    "customer.anonymize.no_parked_deletion",
    "Não há solicitação de exclusão pendente.",
  )
}

/**
 * Cancel succeeded — the parked anonymize is being superseded by this
 * cancel. Semantically this is a REFUSE that *terminates* the parked
 * DEFER chain rather than a permission refusal. Task 14's route layer
 * branches on this code to clear the Redis receipt and record
 * `supersedes: [parked.intentHash]` on the audit envelope.
 *
 * The "REFUSE-supersedes-parked" pattern is documented in
 * `governance/04-decision-policy.md` §"DEFER cancellation semantics" —
 * the cancel is itself a refusal (the system *refuses* to honor the
 * parked anonymize) but the side effect at the route layer is the
 * receipt-clear, not a no-op.
 */
export function refuseAnonymizeCancelSupersedesParked(): Refusal {
  return refuse(
    "STATE",
    "customer.anonymize.cancel_supersedes_parked",
    "Solicitação de exclusão cancelada com sucesso.",
  )
}

// ── Business refusals (BUSINESS_RULE) ───────────────────────────────────

/**
 * Allergen safety-critical guard — emitted when `allergenExclusions` is
 * absent, not an array, or otherwise can't be parsed as an explicit
 * list. CLAUDE.md rule #1: allergens are NEVER inferred. Empty array
 * `[]` is fine; only the *missing-array* / *non-array* case refuses.
 */
export function refuseAllergenInferred(): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "customer.allergens.must_be_explicit",
    "Por segurança, alergias precisam ser informadas explicitamente. Envie uma lista (mesmo que vazia).",
  )
}

/**
 * Rate-limit refusal on `customer.profile.update`. The
 * `hoursRemaining` is a float — formatted with one decimal so a
 * 30-minute remainder reads "0.5h".
 */
export function refuseProfileRateLimit(hoursRemaining: number): Refusal {
  const formatted = hoursRemaining.toFixed(1)
  return refuse(
    "BUSINESS_RULE",
    "customer.profile.rate_limit",
    `Aguarde ${formatted}h antes de atualizar seu perfil novamente.`,
    `hoursRemaining=${formatted}`,
  )
}

/**
 * CPF-shape refusal — emitted when the CPF on
 * `customer.pix.details.save` fails the 11-digit + checksum validation.
 * The Pack does not store or log the offending value; the audit record
 * carries only the basis code, not the raw payload (task 18's redactor
 * is the authority there).
 */
export function refuseCpfInvalid(): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "customer.cpf.invalid_format",
    "CPF inválido. Verifique e tente novamente.",
  )
}

/**
 * Pack-level default-deny. The kernel's own default-deny path emits
 * `default_deny` (see `@adjudicate/locales-pt-BR.portugueseRefusalMessages`);
 * Packs that want a richer user-facing message return this Refusal from
 * a final business-guard fall-through.
 */
export function refuseDefault(reason?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "customer.default.deny",
    "Essa ação não é permitida neste momento.",
    reason,
  )
}

// ── pt-BR locale dictionary (re-export for adopter convenience) ─────────

/**
 * Re-export the kernel locale so adopters who call
 * `localizeDecision(decision, locale)` at presentation can compose this
 * Pack's codes on top:
 *
 * ```ts
 * import { portugueseRefusalMessages } from "@ibatexas/pack-customer-onboarding"
 * import { localizeDecision } from "@adjudicate/core"
 *
 * const userText = localizeDecision(decision, portugueseRefusalMessages)
 * ```
 *
 * The embedded `userFacing` on each Refusal already carries pt-BR text;
 * this re-export is for the kernel-emitted codes the Pack doesn't own.
 */
export { portugueseRefusalMessages }
