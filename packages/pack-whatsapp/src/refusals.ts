/**
 * @ibatexas/pack-whatsapp — typed refusal helpers (pt-BR).
 *
 * Every refusal the Pack's policy emits flows through one of these
 * builders. The machine-readable `code` is stable — observability,
 * drift detection (M3 AaC review), and audit-record analytics key
 * off it. The user-facing text is pt-BR per CLAUDE.md rule #4 and is
 * the only place the strings live.
 *
 * Codes follow the dotted convention prefixed by the Pack's domain
 * (`whatsapp.*`), mirroring the `order.*` / `reservation.*` conventions
 * in `@ibatexas/pack-orders` / `@ibatexas/pack-reservations`.
 *
 * The pt-BR locale dictionary
 * (`@adjudicate/locales-pt-br.portugueseRefusalMessages`) covers
 * kernel-emitted codes (`taint_level_insufficient`, `default_deny`,
 * etc.); Pack-specific codes ship their pt-BR userFacing here so a
 * downstream `localizeDecision()` call falls through to the embedded
 * text rather than the kernel fallback.
 *
 * Note on tone: this Pack's refusals are user-visible on WhatsApp; the
 * text reads as a polite system message rather than a technical
 * explanation. Operator-facing detail goes in the optional `detail`
 * argument.
 */

import { refuse, type Refusal } from "@adjudicate/core"
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br"

// ── State refusals (STATE) ──────────────────────────────────────────────

/**
 * 24-hour customer-initiated window expired. Per Meta/Twilio WhatsApp
 * Business API: outside the 24h window, only pre-approved template
 * messages are deliverable. A free-form message would be silently
 * rejected at Twilio today; the Pack converts that into a clean REFUSE.
 */
export function refuseWindowExpired(): Refusal {
  return refuse(
    "STATE",
    "whatsapp.window.expired",
    "Não consigo enviar essa mensagem agora. Por favor aguarde uma resposta do cliente.",
  )
}

// ── Business refusals (BUSINESS_RULE) ───────────────────────────────────

/**
 * Per-customer handover rate-limit hit at the REFUSE threshold (3rd+
 * handover within `WHATSAPP_HANDOFF_LIMIT_MINUTES`). The REQUEST_CONFIRMATION
 * threshold (2nd handover) is handled separately via
 * `createThresholdGuard`'s prompt path.
 */
export function refuseHandoffRateLimited(): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "whatsapp.handoff.rate_limited",
    "Você já solicitou atendimento humano recentemente. Vou aguardar.",
  )
}

/**
 * Template payload is malformed — name missing or variables empty when
 * the wire schema would otherwise admit them. The Pack rejects rather
 * than letting the WhatsApp client surface a vendor-specific error to
 * the customer.
 */
export function refuseInvalidTemplate(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "whatsapp.template.invalid",
    "Template inválido.",
    detail,
  )
}

/**
 * Pack-level default-deny. The kernel's own default-deny path emits
 * `default_deny` (see `@adjudicate/locales-pt-br.portugueseRefusalMessages`);
 * Packs that want a richer user-facing message return this Refusal
 * from a final business-guard fall-through.
 */
export function refuseDefault(reason?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "whatsapp.default.deny",
    "Operação não permitida.",
    reason,
  )
}

// ── Auth refusals (AUTH) ────────────────────────────────────────────────

/**
 * P1-G — RETIRED, kept only as an exported helper for adopters.
 *
 * STATUS: NO guard in this Pack emits this refusal. It was the auth-phase
 * fail-closed for `whatsapp.message.send` when the upstream forgot to
 * project `state.ctx.recipientType`, because the REWRITE that sanitized
 * the customer string keyed on `recipientType === "staff"` and would
 * silently skip without it. BKL-177 retired that kind, its auth guard
 * (`refuseUnprojectedStaffRouting`) and its REWRITE together.
 *
 * The live customer→staff sanitization (F-43, `sanitizeHandoffReason` in
 * `policies.ts`) has NO such failure mode by construction: it keys on the
 * envelope KIND and the payload's own `reason` field, never on a
 * projected state field, so there is nothing an adopter can forget to
 * project. That is why no replacement fail-closed guard exists.
 *
 * Historical context: Audit 04 §"Finding #3" + Audit 05 §P1-G.
 */
export function refuseUnclassifiedStaffRoute(): Refusal {
  return refuse(
    "AUTH",
    "whatsapp.staff.recipient_unknown",
    "Não foi possível identificar o destinatário desta mensagem. Pedido recusado por segurança.",
  )
}

// ── pt-BR locale dictionary (re-export for adopter convenience) ─────────

/**
 * Re-export the kernel locale so adopters who call
 * `localizeDecision(decision, locale)` at presentation can compose this
 * Pack's codes on top:
 *
 * ```ts
 * import { portugueseRefusalMessages } from "@ibatexas/pack-whatsapp"
 * import { localizeDecision } from "@adjudicate/core"
 *
 * const userText = localizeDecision(decision, portugueseRefusalMessages)
 * ```
 *
 * The embedded `userFacing` on each Refusal already carries pt-BR text;
 * this re-export is for the kernel-emitted codes the Pack doesn't own.
 */
export { portugueseRefusalMessages }
