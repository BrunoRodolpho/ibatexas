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
} from "./refusals.js"
import {
  WHATSAPP_HANDOFF_CONFIRM_COUNT,
  WHATSAPP_HANDOFF_LIMIT_MINUTES,
  WHATSAPP_HANDOFF_REFUSE_COUNT,
  whatsappTaintPolicy,
  type WhatsAppIntentKind,
  type WhatsAppPayload,
  type WhatsAppSessionHandoverPayload,
  type WhatsAppState,
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

// ── Business guards ─────────────────────────────────────────────────────

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
const executeSessionHandover: WhatsAppGuard = (envelope) => {
  if (envelope.kind !== "whatsapp.session.handover") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

/**
 * F5/L3 (BKL-030): customer-side escalation on-ramp. A customer asking for a
 * human is always allowed — no window/rate gate (the customer is initiating,
 * not being messaged). The handoff spine downstream (pause, staff ping,
 * incident) governs the actual takeover; here we only authorize the request.
 */
const executeHandoffRequest: WhatsAppGuard = (envelope) => {
  if (envelope.kind !== "whatsapp.handoff.request") return null
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
 *   1. `refuseExcessiveHandoff` — REFUSE >= 3rd handover (must run
 *      BEFORE the confirm guard so REFUSE wins over CONFIRM).
 *   2. `confirmRepeatedHandoff` — REQUEST_CONFIRMATION 2nd handover.
 *   3. `executeSessionHandover` / `executeHandoffRequest` /
 *      `executeConversationAppend` — happy-path producers.
 */
export const whatsappPolicyBundle: PolicyBundle<
  WhatsAppIntentKind,
  WhatsAppPayload,
  WhatsAppState
> = {
  stateGuards: [],
  authGuards: [requireTenantBindingGuard],
  taint: whatsappTaintPolicy,
  business: [
    refuseExcessiveHandoff,
    confirmRepeatedHandoff,
    executeSessionHandover,
    executeConversationAppend,
    executeHandoffRequest,
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
