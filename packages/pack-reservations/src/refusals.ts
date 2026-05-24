/**
 * @ibatexas/pack-reservations — typed refusal helpers (pt-BR).
 *
 * Every refusal the Pack's policy emits flows through one of these
 * builders. The machine-readable `code` is stable — observability,
 * drift detection (M3 AaC review), and audit-record analytics key
 * off it. The user-facing text is pt-BR per CLAUDE.md rule #4 and is
 * the only place the strings live.
 *
 * Codes follow the dotted convention prefixed by the Pack's domain
 * (`reservation.*`), mirroring the `order.*` convention in
 * `@ibatexas/pack-orders`.
 *
 * The pt-BR locale dictionary
 * (`@adjudicate/locales-pt-BR.portugueseRefusalMessages`) covers
 * kernel-emitted codes (`taint_level_insufficient`, `default_deny`, etc.);
 * Pack-specific codes ship their pt-BR userFacing here so a downstream
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

export function refuseStaffOnly(action: string): Refusal {
  return refuse(
    "AUTH",
    "reservation.staff_only",
    "Só nossa equipe pode fazer essa operação. Quer falar com um atendente?",
    `action=${action}`,
  )
}

// ── State refusals (STATE) ──────────────────────────────────────────────

export function refuseReservationNotFound(): Refusal {
  return refuse(
    "STATE",
    "reservation.not_found",
    "Não encontrei essa reserva.",
  )
}

export function refuseReservationNotModifiable(status: string): Refusal {
  return refuse(
    "STATE",
    "reservation.not_modifiable",
    "Essa reserva não pode mais ser alterada.",
    `status=${status}`,
  )
}

export function refuseReservationNotCancellable(status: string): Refusal {
  return refuse(
    "STATE",
    "reservation.not_cancellable",
    "Essa reserva não pode mais ser cancelada.",
    `status=${status}`,
  )
}

export function refuseSlotNotFound(): Refusal {
  return refuse("STATE", "reservation.slot.not_found", "Horário não encontrado.")
}

export function refuseSlotInPast(): Refusal {
  return refuse(
    "STATE",
    "reservation.slot.in_past",
    "Esse horário já passou. Quer ver os próximos disponíveis?",
  )
}

export function refuseSlotFull(): Refusal {
  return refuse(
    "STATE",
    "reservation.slot.full",
    "Esse horário está esgotado. Quer entrar na lista de espera ou tentar outro horário?",
  )
}

// ── Business refusals (BUSINESS_RULE) ───────────────────────────────────

export function refuseInvalidPartySize(partySize: unknown): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "reservation.party_size.invalid",
    "O número de pessoas precisa ser um inteiro positivo.",
    `partySize=${String(partySize)}`,
  )
}

export function refuseCustomerBlocked(): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "reservation.customer.blocked",
    "Não consigo fazer essa reserva no seu cadastro. Por favor, fale com um atendente.",
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
    "reservation.default.deny",
    "Operação não permitida.",
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
 * import { portugueseRefusalMessages } from "@ibatexas/pack-reservations"
 * import { localizeDecision } from "@adjudicate/core"
 *
 * const userText = localizeDecision(decision, portugueseRefusalMessages)
 * ```
 *
 * The embedded `userFacing` on each Refusal already carries pt-BR text;
 * this re-export is for the kernel-emitted codes the Pack doesn't own.
 */
export { portugueseRefusalMessages }
