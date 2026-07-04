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

/** Every ops refusal code — mirrored into `opsPack.basisCodes`. */
export const OPS_REFUSAL_CODES: readonly string[] = [
  OPS_ADMIN_SESSION_REQUIRED_CODE,
  OPS_AVAILABILITY_PAYLOAD_INVALID_CODE,
  OPS_AVAILABILITY_PRODUCT_NOT_FOUND_CODE,
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

// ── pt-BR locale dictionary (re-export for adopter convenience) ─────────────

/**
 * Re-export the kernel locale so an adopter calling
 * `localizeDecision(decision, portugueseRefusalMessages)` at presentation can
 * compose this pack's embedded pt-BR copy on top of the kernel-emitted codes.
 */
export { portugueseRefusalMessages }
