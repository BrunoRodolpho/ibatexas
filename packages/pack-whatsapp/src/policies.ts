/**
 * @ibatexas/pack-whatsapp — PolicyBundle.
 *
 * Composed from `@adjudicate/primitives` factories
 * (`createSystemTaintPolicy`, `createThresholdGuard`) and an inline
 * REWRITE guard that pipes the body through `sanitizeCustomerString`.
 * The REWRITE is inline rather than via `createRewriteGuard` because
 * that factory is tailored to numeric-cap rewrites (e.g., the PIX
 * refund clamp); the customer-string sanitizer is a categorical
 * transform that doesn't fit the factory's `value > cap` shape.
 *
 * Default polarity is REFUSE — per master plan §"Governance principles"
 * #4 and `governance/04-decision-policy.md` §"Default refuse policy".
 *
 * Guard ordering inside each phase matters. The kernel evaluation order
 * is `state → taint → auth → business` (ADR-104). The state phase here
 * carries the 24h-window guard so an out-of-window outbound is REFUSEd
 * before taint / auth bother. The business phase carries the
 * rate-limit threshold and the customer→staff REWRITE — REWRITE must
 * run before the EXECUTE producer so the executed envelope is the
 * sanitized one.
 *
 * # Migrated behaviour
 *
 * Today, `notification.send` (subscribers/cart-intelligence.ts:665)
 * accepts free-form `body` with no taint check — investigation 04 P0 #6.
 * Handoff (subscribers/handoff-subscriber.ts:14) template-injects
 * customer-supplied `reason` with no rate limit — investigation 08 P1 #4.
 * This Pack defines the policy envelope around those mutations; the
 * actual subscriber refactor lands in task 16.
 */

import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionEscalate,
  decisionExecute,
  decisionRefuse,
  decisionRequestConfirmation,
  decisionRewrite,
} from "@adjudicate/core"
import {
  nameGuard,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createThresholdGuard, requireTenantBinding } from "@adjudicate/primitives"
import {
  refuseDefault,
  refuseHandoffRateLimited,
  refuseInvalidTemplate,
  refuseUnclassifiedStaffRoute,
  refuseWindowExpired,
} from "./refusals.js"
import { sanitizeCustomerString } from "./sanitize.js"
import {
  WHATSAPP_24H_WINDOW_MS,
  WHATSAPP_HANDOFF_CONFIRM_COUNT,
  WHATSAPP_HANDOFF_LIMIT_MINUTES,
  WHATSAPP_HANDOFF_REFUSE_COUNT,
  whatsappTaintPolicy,
  type WhatsAppIntentKind,
  type WhatsAppMessageSendPayload,
  type WhatsAppPayload,
  type WhatsAppSessionHandoverPayload,
  type WhatsAppState,
  type WhatsAppTemplateSendPayload,
} from "./types.js"

type WhatsAppGuard = Guard<WhatsAppIntentKind, WhatsAppPayload, WhatsAppState>

/**
 * Tenant binding (AuthReviewer-009 / RC-A1 D-12). REFUSEs a request whose
 * `state.ctx.tenantId` is not the configured tenant; lenient (no-op) when absent.
 * Reads (actor, state) → Decision — no principal/hashed-byte change. Env-driven (Rule #3).
 */
const requireTenantBindingGuard: WhatsAppGuard = requireTenantBinding<
  WhatsAppIntentKind,
  WhatsAppPayload,
  WhatsAppState
>((_actor, state) => {
  const tenant = state.ctx.tenantId
  return tenant === undefined || tenant === (process.env.KERNEL_TENANT_ID ?? "ibatexas")
})

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * A `whatsapp.message.send` payload that carries a non-empty
 * `templateName` AND non-empty `templateVariables` is treated as a
 * templated outbound — it bypasses the 24h window and the sanitization
 * path. Free-form-only paths use the canonical `whatsapp.template.send`
 * kind; this helper covers the dual-mode `whatsapp.message.send` case
 * for legacy adopters.
 */
function isTemplated(payload: WhatsAppMessageSendPayload): boolean {
  return (
    typeof payload.templateName === "string" &&
    payload.templateName.length > 0 &&
    typeof payload.templateVariables === "object" &&
    payload.templateVariables !== null
  )
}

// ── State guards ────────────────────────────────────────────────────────

/**
 * 24-hour customer-initiated window check. For `whatsapp.message.send`
 * that is not templated, REFUSE when `now - lastCustomerMessageAt >
 * 24h + grace`. Templates and the dedicated `whatsapp.template.send`
 * kind bypass entirely.
 *
 * Conservative on missing data: if `now` is missing, the guard
 * short-circuits (`null`) — the adopter must inject `now` for this
 * guard to fire. If `lastCustomerMessageAt` is missing, the guard
 * treats the window as expired (REFUSE) — absence means "we have no
 * record of a customer message ever", which is the safest default.
 */
const requireWindowOpen: WhatsAppGuard = (envelope, state) => {
  if (envelope.kind !== "whatsapp.message.send") return null
  const payload = envelope.payload as WhatsAppMessageSendPayload
  if (isTemplated(payload)) return null
  const now = state.ctx.now
  if (!now) return null
  const last = state.ctx.lastCustomerMessageAt
  if (!last) {
    return decisionRefuse(refuseWindowExpired(), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "no_prior_customer_message",
      }),
    ])
  }
  const ageMs = now.getTime() - last.getTime()
  if (ageMs <= WHATSAPP_24H_WINDOW_MS) return null
  return decisionRefuse(refuseWindowExpired(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "window_expired",
      ageMs,
      windowMs: WHATSAPP_24H_WINDOW_MS,
    }),
  ])
}

// ── Auth guards ─────────────────────────────────────────────────────────
//
// ── W4 P1-G — fail-closed on missing recipientType ──────────────────────
//
// The business-phase REWRITE (`sanitizeCustomerToStaff`) only fires
// when `state.ctx.recipientType === "staff"`. If the upstream command
// service forgets to project that field, the REWRITE silently skips
// and an unsanitized customer-controlled string reaches a staff
// phone (template-injection, PII echo, etc.) — audit 04 §"Finding #3"
// + audit 05 §P1-G.
//
// The auth-phase REFUSE guard below closes the gap: for
// `whatsapp.message.send` with `senderRole = "customer"` and a
// MISSING `recipientType`, we refuse outright. The legitimate
// customer→staff path (where the upstream projects `recipientType =
// "staff"`) still routes through the REWRITE sanitization in the
// business phase.
//
// Note: customer→customer messages don't need this defense — they
// have `recipientType="customer"` set by the command service. Only
// the case where `recipientType` is undefined / null AND
// `senderRole==="customer"` is fenced off.

/**
 * P1-G — REFUSE customer-controlled `whatsapp.message.send` when the
 * upstream did not project a `recipientType` in state. Defends against
 * the upstream-projection-bug failure mode where the REWRITE guard
 * silently skips and an unsanitized customer string slips through to
 * a staff phone.
 *
 * Logic:
 *   - kind must be `whatsapp.message.send`
 *   - `senderRole` must be `"customer"`
 *   - `recipientType` must be MISSING (undefined or null)
 *
 * Returns `null` in every other case so legitimate paths continue
 * through the existing pipeline.
 */
const refuseUnprojectedStaffRouting: WhatsAppGuard = (envelope, state) => {
  if (envelope.kind !== "whatsapp.message.send") return null
  const payload = envelope.payload as WhatsAppMessageSendPayload
  if (payload.senderRole !== "customer") return null
  // Templated outbounds bypass the 24h window via `isTemplated`; they
  // also bypass this guard because the template path doesn't carry
  // customer-controlled bodies that need sanitization.
  if (isTemplated(payload)) return null
  // Already-classified: let the REWRITE in the business phase handle
  // it (customer→staff sanitization, customer→customer pass-through).
  if (state.ctx.recipientType === "staff") return null
  if (state.ctx.recipientType === "customer") return null
  if (state.ctx.recipientType === "system") return null
  // Missing classification (undefined or null) → REFUSE.
  return decisionRefuse(refuseUnclassifiedStaffRoute(), [
    basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, {
      reason: "recipient_type_unprojected",
      senderRole: payload.senderRole,
    }),
  ])
}

// ── Business guards ─────────────────────────────────────────────────────

/**
 * Templates must have a non-empty name and a (possibly empty) variables
 * map. The Pack's wire schema would normally enforce this; the guard
 * exists so the refusal code stays orthogonal (template-invalid vs
 * default-deny) for analytics + drift detection.
 */
const validateTemplate: WhatsAppGuard = (envelope) => {
  if (envelope.kind !== "whatsapp.template.send") return null
  const payload = envelope.payload as WhatsAppTemplateSendPayload
  if (
    typeof payload.templateName !== "string" ||
    payload.templateName.length === 0
  ) {
    return decisionRefuse(refuseInvalidTemplate("template_name_missing"), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "template_name_required",
      }),
    ])
  }
  if (
    typeof payload.templateVariables !== "object" ||
    payload.templateVariables === null
  ) {
    return decisionRefuse(refuseInvalidTemplate("template_variables_missing"), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "template_variables_required",
      }),
    ])
  }
  return null
}

/**
 * Per-customer handover rate-limit. Uses
 * `@adjudicate/primitives.createThresholdGuard` for the
 * REQUEST_CONFIRMATION → REFUSE escalation.
 *
 * Threshold semantics (per task spec):
 *
 *   - Within `WHATSAPP_HANDOFF_LIMIT_MINUTES`:
 *       handover #1            → EXECUTE (this guard returns null).
 *       handover #2            → REQUEST_CONFIRMATION ("are you sure?").
 *       handover #3+ (>2×)     → REFUSE (clearly abusive).
 *
 * Counter source: `state.ctx.perCustomerHandoffCount[phoneHash]` —
 * adopter projects this from Redis (rolling-window counter). The Pack
 * does not increment; that's the command service's side-effect
 * responsibility (per CLAUDE.md rule #9: Pack defines authority, not
 * side effects).
 *
 * The threshold guard is layered as TWO guards rather than one because
 * each emits a different Decision kind and they need distinct names
 * for analyzer / audit visibility.
 */
const refuseExcessiveHandoff = nameGuard(
  "refuseExcessiveHandoff",
  createThresholdGuard<WhatsAppIntentKind, WhatsAppPayload, WhatsAppState>({
    matches: (env) => env.kind === "whatsapp.session.handover",
    extract: (env, state) => {
      const payload = env.payload as WhatsAppSessionHandoverPayload
      const counts = state.ctx.perCustomerHandoffCount
      if (!counts) return null
      const c = counts[payload.customerPhoneHash]
      return typeof c === "number" ? c : 0
    },
    threshold: WHATSAPP_HANDOFF_REFUSE_COUNT,
    comparator: ">=",
    onCross: (value, threshold) =>
      decisionRefuse(refuseHandoffRateLimited(), [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "handoff_rate_limit_exceeded",
          windowMinutes: WHATSAPP_HANDOFF_LIMIT_MINUTES,
          count: value,
          refuseAt: threshold,
        }),
      ]),
  }),
) as WhatsAppGuard

const confirmRepeatedHandoff = nameGuard(
  "confirmRepeatedHandoff",
  createThresholdGuard<WhatsAppIntentKind, WhatsAppPayload, WhatsAppState>({
    matches: (env) => env.kind === "whatsapp.session.handover",
    extract: (env, state) => {
      const payload = env.payload as WhatsAppSessionHandoverPayload
      const counts = state.ctx.perCustomerHandoffCount
      if (!counts) return null
      const c = counts[payload.customerPhoneHash]
      return typeof c === "number" ? c : 0
    },
    threshold: WHATSAPP_HANDOFF_CONFIRM_COUNT,
    comparator: ">=",
    onCross: (value, threshold) =>
      decisionRequestConfirmation(
        "Você acabou de pedir atendimento humano. Confirma que quer falar com a equipe de novo?",
        [
          basis("business", BASIS_CODES.business.RULE_SATISFIED, {
            rule: "handoff_repeat_confirm",
            windowMinutes: WHATSAPP_HANDOFF_LIMIT_MINUTES,
            count: value,
            confirmAt: threshold,
          }),
        ],
      ),
  }),
) as WhatsAppGuard

/**
 * Customer-controlled-string REWRITE. Fires for
 * `whatsapp.message.send` where `senderRole = "customer"` AND
 * `recipientType = "staff"` — the canonical "user-controlled `reason`
 * staff-bound" path from investigation 08 P1 #4.
 *
 * The auth guard above REFUSEs this combination outright; this REWRITE
 * is the defence-in-depth layer that fires only if a future refactor
 * narrows the auth guard. The implementation:
 *
 *   1. Sanitize `payload.body` via `sanitizeCustomerString`.
 *   2. If unchanged, return `null` (no REWRITE needed).
 *   3. Otherwise emit `decisionRewrite` with the sanitized envelope.
 *
 * Inline rather than via `createRewriteGuard` because that factory is
 * tailored to numeric-cap rewrites (e.g., the PIX refund clamp). The
 * structure follows the same metadata convention via `nameGuard`.
 *
 * Per CLAUDE.md rule #4: refusal / surface text is pt-BR; the
 * REWRITE's `reason` string is pt-BR for the same reason.
 */
const sanitizeCustomerToStaff: WhatsAppGuard = (envelope, state) => {
  if (envelope.kind !== "whatsapp.message.send") return null
  const payload = envelope.payload as WhatsAppMessageSendPayload
  if (payload.senderRole !== "customer") return null
  if (state.ctx.recipientType !== "staff") return null
  if (typeof payload.body !== "string") return null
  const sanitized = sanitizeCustomerString(payload.body)
  if (sanitized === payload.body) return null
  const newPayload: WhatsAppMessageSendPayload = {
    ...payload,
    body: sanitized,
  }
  const rewritten = buildEnvelope({
    kind: envelope.kind,
    payload: newPayload as unknown as WhatsAppPayload,
    actor: envelope.actor,
    taint: envelope.taint,
    nonce: envelope.nonce,
    createdAt: envelope.createdAt,
  })
  return decisionRewrite(
    rewritten,
    "Mensagem ajustada para envio à equipe.",
    [
      basis("validation", BASIS_CODES.validation.UNICODE_NORMALIZED, {
        reason: "customer_to_staff_sanitized",
        field: "body",
        originalLength: payload.body.length,
        sanitizedLength: sanitized.length,
      }),
    ],
  )
}

// ── EXECUTE producers (default is REFUSE; positive matches required) ────

/**
 * Each happy-path kind needs an explicit EXECUTE guard because the
 * Pack's default is REFUSE. The kernel's evaluation order means these
 * fire AFTER the state / auth / taint / business-refuse guards reject
 * the failing cases.
 *
 * The guards are intentionally narrow — one per intent kind — so audit
 * basis carries the kind in a machine-readable form.
 */
const executeMessageSend: WhatsAppGuard = (envelope) => {
  if (envelope.kind !== "whatsapp.message.send") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeTemplateSend: WhatsAppGuard = (envelope) => {
  if (envelope.kind !== "whatsapp.template.send") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeSessionHandover: WhatsAppGuard = (envelope) => {
  if (envelope.kind !== "whatsapp.session.handover") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

/**
 * W5-6: persistence-side append. SYSTEM-only (taint-gated) — the
 * conversation-archiver subscriber emits this for archival, not the LLM.
 * The Pack does not validate the body beyond non-empty — the archiver
 * is responsible for upstream content vetting.
 */
const executeConversationAppend: WhatsAppGuard = (envelope) => {
  if (envelope.kind !== "conversation.message.append") return null
  const payload = envelope.payload as { body?: unknown }
  if (typeof payload.body !== "string" || payload.body.length === 0) {
    return decisionRefuse(refuseDefault("conversation_body_empty"), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "body_non_empty",
        kind: envelope.kind,
      }),
    ])
  }
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

// ── PolicyBundle ────────────────────────────────────────────────────────

/**
 * The WhatsApp-domain PolicyBundle. Feed to `adjudicate()` from
 * `@adjudicate/core/kernel` to decide whether to execute a proposed
 * envelope. Default is REFUSE — any kind not covered by an explicit
 * EXECUTE guard is denied by construction.
 *
 * Phase order is fixed by the kernel: `state → taint → auth →
 * business → default`.
 *
 * Guard ordering within business phase matters:
 *   1. `validateTemplate` — REFUSE malformed templates first.
 *   2. `refuseExcessiveHandoff` — REFUSE >= 3rd handover (must run
 *      BEFORE the confirm guard so REFUSE wins over CONFIRM).
 *   3. `confirmRepeatedHandoff` — REQUEST_CONFIRMATION 2nd handover.
 *   4. `sanitizeCustomerToStaff` — REWRITE the body BEFORE EXECUTE
 *      so the executed envelope is the sanitized one.
 *   5. `executeMessageSend` / `executeTemplateSend` /
 *      `executeSessionHandover` — happy-path producers.
 */
export const whatsappPolicyBundle: PolicyBundle<
  WhatsAppIntentKind,
  WhatsAppPayload,
  WhatsAppState
> = {
  stateGuards: [requireWindowOpen],
  // P1-G — auth-phase REFUSE when the upstream forgets to project
  // recipientType for a customer-sourced message. Without this guard
  // the REWRITE silently skips and unsanitized customer content can
  // reach a staff phone.
  authGuards: [requireTenantBindingGuard, refuseUnprojectedStaffRouting],
  taint: whatsappTaintPolicy,
  business: [
    validateTemplate,
    refuseExcessiveHandoff,
    confirmRepeatedHandoff,
    sanitizeCustomerToStaff,
    executeMessageSend,
    executeTemplateSend,
    executeSessionHandover,
    executeConversationAppend,
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
 * Suppress the unused-import warnings for `decisionEscalate` — adopters
 * who want a richer escalation path import it from here; the Pack
 * itself does not currently emit ESCALATE.
 *
 * Likewise `refuseDefault` is exported in case adopters want to wrap
 * their own business guard with a richer fallback refusal.
 */
export { decisionEscalate, refuseDefault }
