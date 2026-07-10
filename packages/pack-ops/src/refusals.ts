/**
 * @ibatexas/pack-ops — typed refusal helpers (pt-BR).
 *
 * Every refusal the ops pack emits flows through one of these builders. The
 * machine-readable `code` is stable (audit / drift detection key off it) and
 * MUST be listed in `opsPack.basisCodes` (index.ts) or the M3 AaC / AC-004
 * basis-vocabulary-purity check fails. User-facing text is pt-BR per CLAUDE.md
 * rule #4 and lives only here.
 *
 * Codes follow the dotted convention prefixed by the pack's domain (`ops.*`),
 * mirroring the `whatsapp.*` / `order.*` conventions in the sibling packs.
 */

import { refuse, type Refusal } from "@adjudicate/core"
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br"

/** Refusal `code` for a non-`admin:` session reaching an ops kind (AUTH). */
export const OPS_ADMIN_SESSION_REQUIRED_CODE = "ops.admin_session_required"

/** Refusal `code` for a malformed `product.availability.set` payload. */
export const OPS_AVAILABILITY_PAYLOAD_INVALID_CODE =
  "ops.availability.payload_invalid"

/** Refusal `code` for a `product.availability.set` whose product is unknown. */
export const OPS_AVAILABILITY_PRODUCT_NOT_FOUND_CODE =
  "ops.availability.product_not_found"

/** Refusal `code` for a malformed `product.price.set` payload (NEW-004). */
export const OPS_PRICE_PAYLOAD_INVALID_CODE = "ops.price.payload_invalid"

/** Refusal `code` for a `product.price.set` whose product is unknown (NEW-004). */
export const OPS_PRICE_PRODUCT_NOT_FOUND_CODE = "ops.price.product_not_found"

/**
 * Refusal `code` for a `product.price.set` against a product with MULTIPLE
 * differently-priced variants — per-variation pricing by message is not
 * supported in v1 (the message does not disambiguate which variation). NEW-004.
 */
export const OPS_PRICE_PER_VARIANT_UNSUPPORTED_CODE =
  "ops.price.per_variant_unsupported"

/**
 * Refusal `code` for a `product.price.set` whose parsed price is absurd (above
 * the sanity ceiling — a defensive cap against a gross misparse). NEW-004.
 */
export const OPS_PRICE_OUT_OF_RANGE_CODE = "ops.price.out_of_range"

/** Refusal `code` for a malformed `ops.alert.resolve.staff` payload (BKL-088). */
export const OPS_ALERT_RESOLVE_PAYLOAD_INVALID_CODE =
  "ops.alert_resolve.payload_invalid"

/**
 * Refusal `code` for an `ops.alert.resolve.staff` whose alert is unknown OR
 * already terminal (fail-closed; the basis `reason` distinguishes
 * `not_found` vs `already_resolved`). BKL-088.
 */
export const OPS_ALERT_RESOLVE_NOT_ACTIONABLE_CODE =
  "ops.alert_resolve.not_actionable"

/** Refusal `code` for a malformed `incident.ticket.close.staff` payload (BKL-088). */
export const OPS_INCIDENT_CLOSE_PAYLOAD_INVALID_CODE =
  "ops.incident_close.payload_invalid"

/**
 * Refusal `code` for an `incident.ticket.close.staff` whose incident is unknown
 * OR already terminal (fail-closed; the basis `reason` distinguishes
 * `not_found` vs `already_closed`). BKL-088.
 */
export const OPS_INCIDENT_CLOSE_NOT_ACTIONABLE_CODE =
  "ops.incident_close.not_actionable"

/** Refusal `code` for a malformed `schedule.override.set` payload (SCN-127). */
export const OPS_SCHEDULE_OVERRIDE_PAYLOAD_INVALID_CODE =
  "ops.schedule_override.payload_invalid"

/**
 * Refusal `code` for a `schedule.override.set` whose date is not actionable — a
 * PAST business day, or the today-or-future reference could not be projected
 * (fail-closed; the basis `reason` distinguishes `past_date` vs
 * `reference_unavailable`). SCN-127.
 */
export const OPS_SCHEDULE_OVERRIDE_DATE_NOT_ACTIONABLE_CODE =
  "ops.schedule_override.date_not_actionable"

/** Every ops refusal code — mirrored into `opsPack.basisCodes`. */
export const OPS_REFUSAL_CODES: readonly string[] = [
  OPS_ADMIN_SESSION_REQUIRED_CODE,
  OPS_AVAILABILITY_PAYLOAD_INVALID_CODE,
  OPS_AVAILABILITY_PRODUCT_NOT_FOUND_CODE,
  OPS_PRICE_PAYLOAD_INVALID_CODE,
  OPS_PRICE_PRODUCT_NOT_FOUND_CODE,
  OPS_PRICE_PER_VARIANT_UNSUPPORTED_CODE,
  OPS_PRICE_OUT_OF_RANGE_CODE,
  OPS_ALERT_RESOLVE_PAYLOAD_INVALID_CODE,
  OPS_ALERT_RESOLVE_NOT_ACTIONABLE_CODE,
  OPS_INCIDENT_CLOSE_PAYLOAD_INVALID_CODE,
  OPS_INCIDENT_CLOSE_NOT_ACTIONABLE_CODE,
  OPS_SCHEDULE_OVERRIDE_PAYLOAD_INVALID_CODE,
  OPS_SCHEDULE_OVERRIDE_DATE_NOT_ACTIONABLE_CODE,
]

// ── Auth refusals (AUTH) ────────────────────────────────────────────────────

/**
 * The kind reached the pack on a non-staff session. Role-opaque, security
 * framing (SCN-125 spirit): the reply never reveals the ops verb surface to a
 * customer/LLM caller. `detail` (non-user-facing) carries the machine reason.
 */
export function refuseAdminSessionRequired(detail?: string): Refusal {
  return refuse(
    "AUTH",
    OPS_ADMIN_SESSION_REQUIRED_CODE,
    "Ação disponível apenas para a equipe.",
    detail,
  )
}

// ── Business / schema refusals ──────────────────────────────────────────────

/**
 * `product.availability.set` payload failed strict validation (wrong types,
 * missing `productId`/`available`, or an unknown key). The user-facing copy is
 * generic; `detail` names the offending field for audit.
 */
export function refuseAvailabilityPayloadInvalid(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_AVAILABILITY_PAYLOAD_INVALID_CODE,
    "Não foi possível processar esta operação.",
    detail,
  )
}

/**
 * The target product does not exist in the projected ops state (or was not
 * projected at all). Fail-closed — a toggle against an unknown product is
 * REFUSEd rather than silently no-op'd.
 */
export function refuseAvailabilityProductNotFound(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_AVAILABILITY_PRODUCT_NOT_FOUND_CODE,
    "Produto não encontrado.",
    detail,
  )
}

// ── NEW-004 price-change refusals ────────────────────────────────────────────

/**
 * `product.price.set` payload failed strict validation (missing/empty
 * `productId`, non-integer / non-positive `priceCentavos`, non-string `reason`,
 * or an unknown key). Generic user copy; `detail` names the offending field.
 */
export function refusePricePayloadInvalid(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_PRICE_PAYLOAD_INVALID_CODE,
    "Não foi possível processar esta operação.",
    detail,
  )
}

/**
 * The target product does not exist in the projected ops state (or has no
 * BRL-priced variant to re-price). Fail-closed — a price change against an
 * unknown product is REFUSEd rather than silently no-op'd.
 */
export function refusePriceProductNotFound(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_PRICE_PRODUCT_NOT_FOUND_CODE,
    "Produto não encontrado.",
    detail,
  )
}

/**
 * The target product has MULTIPLE differently-priced variants (per-variation
 * pricing, e.g. 500g vs 1kg). v1 does not disambiguate which variation the
 * owner meant, so it REFUSEs honestly rather than guess.
 */
export function refusePricePerVariantUnsupported(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_PRICE_PER_VARIANT_UNSUPPORTED_CODE,
    "Preço por variação ainda não é suportado por mensagem.",
    detail,
  )
}

/**
 * The parsed price is absurd (above the sanity ceiling — see
 * `getPriceSanityMaxCentavos`). A defensive REFUSE against a gross misparse.
 */
export function refusePriceOutOfRange(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_PRICE_OUT_OF_RANGE_CODE,
    "Esse valor de preço está fora do limite permitido.",
    detail,
  )
}

// ── BKL-088 alert-resolve refusals ──────────────────────────────────────────

/**
 * `ops.alert.resolve.staff` payload failed strict validation (missing/empty
 * `alertId`, non-string `reason`, or an unknown key). Generic user copy;
 * `detail` names the offending field for audit.
 */
export function refuseAlertResolvePayloadInvalid(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_ALERT_RESOLVE_PAYLOAD_INVALID_CODE,
    "Não foi possível processar esta operação.",
    detail,
  )
}

/**
 * The target alert does not exist in the projected ops state, or is already
 * terminal (resolved/auto-resolved). Fail-closed — resolving an unknown or
 * already-closed alert is REFUSEd rather than silently no-op'd.
 */
export function refuseAlertResolveNotActionable(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_ALERT_RESOLVE_NOT_ACTIONABLE_CODE,
    "Alerta não encontrado ou já resolvido.",
    detail,
  )
}

// ── BKL-088 incident-close refusals ─────────────────────────────────────────

/**
 * `incident.ticket.close.staff` payload failed strict validation (missing/empty
 * `incidentId`, non-string `reason`, or an unknown key).
 */
export function refuseIncidentClosePayloadInvalid(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_INCIDENT_CLOSE_PAYLOAD_INVALID_CODE,
    "Não foi possível processar esta operação.",
    detail,
  )
}

/**
 * The target incident does not exist in the projected ops state, or is already
 * terminal (resolved/auto-resolved). Fail-closed — closing an unknown or
 * already-closed incident is REFUSEd rather than silently no-op'd.
 */
export function refuseIncidentCloseNotActionable(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_INCIDENT_CLOSE_NOT_ACTIONABLE_CODE,
    "Incidente não encontrado ou já fechado.",
    detail,
  )
}

// ── SCN-127 schedule-override refusals ──────────────────────────────────────

/**
 * `schedule.override.set` payload failed strict validation (missing/malformed
 * `date`, non-boolean `isOpen`, incoherent `blocks` for the `isOpen` state, a
 * malformed time window, or an unknown key). Generic user copy; `detail` names
 * the offending field for audit.
 */
export function refuseScheduleOverridePayloadInvalid(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_SCHEDULE_OVERRIDE_PAYLOAD_INVALID_CODE,
    "Não foi possível processar esta operação.",
    detail,
  )
}

/**
 * The `schedule.override.set` date is not actionable — a business day already in
 * the past, or the today-or-future reference could not be projected. Fail-closed:
 * an override is never written for a past day, and never written blind when the
 * reference date is missing.
 */
export function refuseScheduleOverrideDateNotActionable(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    OPS_SCHEDULE_OVERRIDE_DATE_NOT_ACTIONABLE_CODE,
    "Só é possível alterar o horário de hoje em diante.",
    detail,
  )
}

// ── pt-BR locale dictionary (re-export for adopter convenience) ─────────────

/**
 * Re-export the kernel locale so an adopter calling
 * `localizeDecision(decision, portugueseRefusalMessages)` at presentation can
 * compose this pack's embedded pt-BR copy on top of the kernel-emitted codes.
 */
export { portugueseRefusalMessages }
