/**
 * @ibatexas/pack-whatsapp — first-party Pack for the WhatsApp egress domain.
 *
 * Third first-party Pack after `@ibatexas/pack-orders` and
 * `@ibatexas/pack-reservations`. Adds policy coverage for the
 * channel-level intents that today exit the system as silent egress:
 *
 *   - 24-hour customer-initiated window enforcement
 *     (Meta/Twilio Business API rule; today's free-form
 *     `notification.send` subscriber silently fails outside the window).
 *   - Per-customer staff-handover rate limit
 *     (investigation 08 P1 #4: handoff flood vector).
 *   - Customer-controlled-string sanitization for staff-bound messages
 *     (defence-in-depth against template-injection in staff WhatsApp).
 *
 * Follows the `pack-reservations` template per CLAUDE.md rule #9 / ADR #13.
 *
 * Two adoption patterns:
 *
 *   1. Canonical-Pack-intent (recommended): import `whatsappPack`,
 *      dispatch envelopes against `whatsappPack.policy`. The Pack's
 *      intent kinds (`whatsapp.message.send`, `whatsapp.template.send`,
 *      `whatsapp.session.handover`) are the wire contract; the master
 *      taxonomy at `docs/adjudicate-migration/governance/01-intent-taxonomy.md`
 *      §"Domain: whatsapp" is authoritative.
 *
 *   2. Bundle-only: import `whatsappPolicyBundle` and feed to
 *      `adjudicate()` directly. Task 16's NATS-subscriber refactor uses
 *      this pattern to wrap the existing
 *      `apps/api/src/subscribers/cart-intelligence.ts:665` (`notification.send`
 *      handler) and `subscribers/handoff-subscriber.ts:14` calls.
 *
 * Conformance: `whatsappPack satisfies PackV0<...>`. The
 * `__tests__/conformance.test.ts` corpus pins behaviour;
 * `runConformance(whatsappPack)` from `@adjudicate/conformance` runs
 * the kernel-level invariant suite (taint protection, replay
 * determinism, basis-vocabulary purity, guard ordering, default
 * polarity).
 *
 * # Scope
 *
 * Per investigation 05 §"Packs ibatexas should write" this Pack covers
 * three of the six whatsapp-domain intent kinds in the master taxonomy.
 * The remaining three (`whatsapp.handoff.request`,
 * `whatsapp.followup.schedule`, `whatsapp.outreach.send`) are owned by
 * later tasks; the `handover` rate-limit machinery in this Pack will
 * generalize there.
 */

import type { PackV0 } from "@adjudicate/core"
import { whatsappCapabilityPlanner } from "./capabilities.js"
import { whatsappPolicyBundle } from "./policies.js"
import type {
  WhatsAppContext,
  WhatsAppIntentKind,
  WhatsAppPayload,
  WhatsAppState,
} from "./types.js"

// ── Rehydrator ──────────────────────────────────────────────────────────

/**
 * Reconstitute a `WhatsAppState` from a JSON-serializable representation.
 *
 * `Date` fields inside `ctx` (`now`, `lastCustomerMessageAt`) don't
 * survive `JSON.stringify` — they come back as ISO strings. This
 * rehydrator promotes them back to `Date`. All other fields pass
 * through.
 *
 * Permissive on input per the `PackV0.rehydrateState` convention:
 * malformed/missing fields fall back to empty defaults so scenario
 * fixtures and audit-replay payloads can be lenient while the policy's
 * guards remain the authoritative validators.
 */
export function rehydrateWhatsAppState(raw: unknown): WhatsAppState {
  if (typeof raw !== "object" || raw === null || !("ctx" in raw)) {
    return {
      ctx: {
        channel: "whatsapp",
        customerId: null,
        staffId: null,
      },
    }
  }
  const ctxRaw = (raw as { ctx: unknown }).ctx
  if (typeof ctxRaw !== "object" || ctxRaw === null) {
    return {
      ctx: {
        channel: "whatsapp",
        customerId: null,
        staffId: null,
      },
    }
  }
  const ctx = ctxRaw as WhatsAppState["ctx"] & {
    now?: unknown
    lastCustomerMessageAt?: unknown
  }

  const toDate = (value: unknown): Date | null => {
    if (value instanceof Date) return value
    if (typeof value === "string" || typeof value === "number") {
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? null : d
    }
    return null
  }

  return {
    ...((raw as object) || {}),
    ctx: {
      ...ctx,
      now: toDate(ctx.now) ?? null,
      lastCustomerMessageAt: toDate(ctx.lastCustomerMessageAt) ?? null,
    },
  } as WhatsAppState
}

// ── Re-exports for adopter convenience ──────────────────────────────────

export {
  WHATSAPP_24H_WINDOW_GRACE_SECONDS,
  WHATSAPP_24H_WINDOW_MS,
  WHATSAPP_HANDOFF_CONFIRM_COUNT,
  WHATSAPP_HANDOFF_LIMIT_MINUTES,
  WHATSAPP_HANDOFF_REFUSE_COUNT,
  WHATSAPP_SANITIZE_MAX_LENGTH,
  whatsappTaintPolicy,
  type WhatsAppContext,
  type ConversationMessageAppendPayload,
  type WhatsAppIntentKind,
  type WhatsAppMessageSendPayload,
  type WhatsAppPayload,
  type WhatsAppRecipientRole,
  type WhatsAppSenderRole,
  type WhatsAppSessionHandoverPayload,
  type WhatsAppState,
  type WhatsAppTemplateSendPayload,
} from "./types.js"

export {
  refuseDefault,
  refuseHandoffRateLimited,
  refuseInvalidTemplate,
  refuseUnclassifiedStaffRoute,
  refuseWindowExpired,
  portugueseRefusalMessages,
} from "./refusals.js"

export { sanitizeCustomerString } from "./sanitize.js"

export { whatsappPolicyBundle } from "./policies.js"

export {
  WHATSAPP_TOOL_TO_INTENT,
  WHATSAPP_TOOLS,
  whatsappCapabilityPlanner,
} from "./capabilities.js"

/**
 * The Pack as a `PackV0`-conformant value. The `satisfies` clause
 * provides compile-time conformance — drift from `PackV0`'s shape
 * fails the build. `intents` stays narrowly typed via the explicit
 * type parameters; the master taxonomy (governance §"Domain: whatsapp")
 * is the source of truth.
 *
 * Pack id convention matches `@ibatexas/pack-orders.id =
 * "ibatexas/pack-orders"`: short, no scope prefix on the `id` field
 * itself; the npm scope lives in `package.json` only.
 */
export const whatsappPack = {
  id: "ibatexas/pack-whatsapp",
  version: "1.1.0",
  contract: "v0",
  intents: [
    "whatsapp.message.send",
    "whatsapp.template.send",
    "whatsapp.session.handover",
    "conversation.message.append",
  ],
  policy: whatsappPolicyBundle,
  planner: whatsappCapabilityPlanner,
  /**
   * Refusal codes the Pack's policy may emit. The M3 AaC drift check
   * (`assertPackConformance` + `withBasisAudit`) verifies that
   * runtime emissions stay inside this set; new code added in
   * `refusals.ts` MUST be added here too.
   */
  basisCodes: [
    "whatsapp.window.expired",
    "whatsapp.handoff.rate_limited",
    "whatsapp.template.invalid",
    "whatsapp.default.deny",
    // P1-G — auth-phase refusal when upstream forgets recipientType.
    "whatsapp.staff.recipient_unknown",
  ],
  /**
   * Wire signals this Pack parks on via DEFER. Empty — this Pack does
   * not currently DEFER. (A future enhancement may DEFER outbound
   * messages on Twilio rate-limit `429` signals.)
   */
  signals: [],
  rehydrateState: rehydrateWhatsAppState,
} as const satisfies PackV0<
  WhatsAppIntentKind,
  WhatsAppPayload,
  WhatsAppState,
  WhatsAppContext
>
