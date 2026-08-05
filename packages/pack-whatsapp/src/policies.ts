/**
 * @ibatexas/pack-whatsapp — PolicyBundle.
 *
 * Composed from `@adjudicate/primitives` factories
 * (`createSystemTaintPolicy`, `createThresholdGuard`) and an inline
 * REWRITE guard that pipes `whatsapp.handoff.request`'s customer-supplied
 * `reason` through `sanitizeCustomerString`.
 * The REWRITE is inline rather than via `createRewriteGuard` because
 * that factory is tailored to numeric-cap rewrites (e.g., the PIX
 * refund clamp); the customer-string sanitizer is a categorical
 * transform that doesn't fit the factory's `value > cap` shape.
 *
 * Default polarity is REFUSE — per master plan §"Governance principles"
 * #4 and `governance/04-decision-policy.md` §"Default refuse policy".
 *
 * Guard ordering inside each phase matters. The kernel evaluation order
 * is `state → taint → auth → business` (ADR-104), and within a phase the
 * FIRST guard returning a non-null Decision wins and short-circuits
 * (`@adjudicate/core/kernel/adjudicate.js` — the business loop returns on
 * the first non-null). The state phase is empty here (BKL-177 retired the
 * 24h-window guard along with the kinds it served). In the business phase
 * the ONE load-bearing ordering constraint is that
 * `sanitizeHandoffReason` (REWRITE) must precede `executeHandoffRequest`
 * (EXECUTE) — they match the SAME kind, so if the producer ran first it
 * would win and the unsanitized envelope would be the executed one.
 *
 * The rate-limit threshold guards impose NO ordering constraint on the
 * REWRITE: they match `whatsapp.session.handover` only, a disjoint kind,
 * so they can never race it. (They do constrain each other — REFUSE
 * before CONFIRM; see the bundle's own note below.)
 *
 * # Migrated behaviour
 *
 * `notification.send` (subscribers/cart-intelligence.ts) accepts free-form
 * `body` with no taint check — investigation 04 P0 #6; that path is not yet
 * a Pack intent.
 *
 * Handoff: `apps/api/src/subscribers/handoff-subscriber.ts` interpolates
 * the customer-supplied `reason` into a staff-bound WhatsApp message
 * (`Motivo: ${reason}`, then `sender.sendText(staffPhone, ...)`) —
 * investigation 08 P1 #4. Nothing downstream sanitizes it: the egress
 * `RenderedReply` brand (`mintBroadcastReply`) is a provenance marker, not
 * a content filter, and the `twilio.message.send` wrapper guard only checks
 * non-emptiness. `sanitizeHandoffReason` below is therefore the enforcing
 * layer, not defence-in-depth — the kernel REWRITE is what makes the
 * executed envelope (and so the NATS payload the subscriber reads) safe.
 * The @claustrum dispatcher honours this: on REWRITE it executes with
 * `decision.rewritten.payload` (`@claustrum/core` execution/dispatch.ts
 * `case "REWRITE"`), so the sanitized `reason` is what reaches the executor.
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
import { sanitizeCustomerString } from "./sanitize.js"
import {
  WHATSAPP_HANDOFF_CONFIRM_COUNT,
  WHATSAPP_HANDOFF_LIMIT_MINUTES,
  WHATSAPP_HANDOFF_REFUSE_COUNT,
  whatsappTaintPolicy,
  type WhatsAppHandoffRequestPayload,
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

/**
 * Customer-controlled-string REWRITE — the enforcing half of
 * investigation 08 P1 #4 ("user-controlled `reason` is template-injected
 * into a staff-bound WhatsApp message").
 *
 * `whatsapp.handoff.request` is this Pack's ONE untrusted, customer-
 * proposable kind: the LLM extracts a free-text `reason` from the
 * customer's own words (see the `reason` field in
 * `apps/api/src/claustrum/language-engine/customer-whatsapp-convenience.schema.ts`,
 * `trustClass: "directive"`). That string is published verbatim on
 * `support.handoff_requested` and interpolated into the staff alert by
 * `apps/api/src/subscribers/handoff-subscriber.ts` — BETWEEN two
 * system-authored lines and directly above the OWNER-approval / deep-link
 * lines. Unsanitized newlines + WhatsApp markdown therefore let a customer
 * forge system-looking lines in a message staff are trained to act on.
 *
 * This guard closes that at the kernel seam:
 *
 *   1. Sanitize `payload.reason` via `sanitizeCustomerString` (strips
 *      newlines / markdown control chars / zero-width chars, collapses
 *      whitespace, truncates to `WHATSAPP_SANITIZE_MAX_LENGTH`).
 *   2. If unchanged, return `null` — a clean reason is NOT rewritten, so
 *      the ordinary EXECUTE path is byte-for-byte unaffected.
 *   3. Otherwise emit `decisionRewrite` carrying the sanitized envelope.
 *
 * The envelope is rebuilt with `buildEnvelope` (not spread) because the
 * kernel's `gateRewrite` re-derives the rewritten envelope's `intentHash`
 * and fail-closes on a mismatch; `buildEnvelope` is what computes it.
 * `actor` / `taint` / `nonce` / `createdAt` are carried over unchanged —
 * a rewrite may narrow content but never elevate trust (the kernel also
 * enforces taint monotonicity here).
 *
 * Inline rather than via `createRewriteGuard` because that factory is
 * tailored to numeric-cap rewrites (e.g., the PIX refund clamp); a
 * categorical string transform doesn't fit its `value > cap` shape.
 *
 * ORDERING: must precede `executeHandoffRequest` — same kind, and the
 * business phase is first-non-null-wins. `__tests__/whatsapp-pack.test.ts`
 * pins that relative order.
 *
 * # Known, ACCEPTED side effect — compound turns (owner-ruled, F-43)
 *
 * Multi-envelope plans are kill-all-or-execute-all: `adjudicatePlan`
 * (`apps/api/src/claustrum-bootstrap.ts`) returns on the FIRST envelope
 * whose decision is not EXECUTE. So on a compound turn — a customer who
 * asks for a human AND requests another mutation in one message — a
 * REWRITE here ends the loop and the sibling envelopes are not executed.
 *
 * This guard does NOT introduce that behaviour; it joins it. Any REFUSE,
 * REQUEST_CONFIRMATION or DEFER in the same position does the same, and
 * `pack-orders`' `clampUpdateToStockCap` is an existing production REWRITE
 * under identical plan semantics. The direction is fail-safe: a dropped
 * sibling is a turn that does LESS, never a turn that does something
 * wrong, and the customer can restate the dropped request.
 *
 * Bounded: `whatsapp.handoff.request` is not a workflow activity (every
 * workflow in `packages/catalog/src/workflows/definitions.ts` is `order.*`),
 * so the workflow-runtime REWRITE gap — where a REWRITE halts the run
 * instead of executing either payload — does not apply here.
 *
 * Per CLAUDE.md rule #4 the REWRITE's user-facing reason string is pt-BR.
 */
const sanitizeHandoffReason: WhatsAppGuard = (envelope) => {
  if (envelope.kind !== "whatsapp.handoff.request") return null
  const payload = envelope.payload as WhatsAppHandoffRequestPayload
  if (typeof payload.reason !== "string") return null
  const sanitized = sanitizeCustomerString(payload.reason)
  if (sanitized === payload.reason) return null
  const newPayload: WhatsAppHandoffRequestPayload = {
    ...payload,
    reason: sanitized,
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
        field: "reason",
        originalLength: payload.reason.length,
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
 * Guard ordering within business phase matters (first non-null wins):
 *   1. `refuseExcessiveHandoff` — REFUSE >= 3rd handover (must run
 *      BEFORE the confirm guard so REFUSE wins over CONFIRM).
 *   2. `confirmRepeatedHandoff` — REQUEST_CONFIRMATION 2nd handover.
 *   3. `sanitizeHandoffReason` — REWRITE the customer-supplied `reason`
 *      BEFORE `executeHandoffRequest` so the EXECUTED envelope is the
 *      sanitized one. Same kind as that producer, so this order is
 *      load-bearing, not cosmetic.
 *   4. `executeSessionHandover` / `executeHandoffRequest` /
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
    // MUST stay ahead of `executeHandoffRequest` — same kind, first-non-null
    // wins, so a producer placed first would execute the unsanitized envelope.
    sanitizeHandoffReason,
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
