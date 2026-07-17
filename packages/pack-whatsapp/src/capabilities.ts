/**
 * @ibatexas/pack-whatsapp — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool visibility for the WhatsApp egress domain. The LLM
 * never sees MUTATING tools (CLAUDE.md rule #9); MUTATING calls are
 * captured as `IntentEnvelope`s and adjudicated through the kernel.
 *
 * The WhatsApp channel-level intents (`whatsapp.message.send`,
 * `whatsapp.template.send`, `whatsapp.session.handover`) stay wholly
 * LLM-invisible — they are emitted by:
 *
 *   - the `cart-intelligence` NATS subscriber (templated outreach),
 *   - the `handoff-subscriber` (session handover),
 *   - the `notification.send` subscriber (templated customer messages),
 *
 * none of which are LLM-proposable.
 *
 * FE-T14 (BKL-030-activation): `whatsapp.handoff.request` IS now
 * advertised, unconditionally, for every session context — the governed
 * intent was fully wired (registered, policied, adjudicable) since F5/L3
 * but withheld from the model surface pending this activation. It is the
 * one guest-accessible verb in the whole roster
 * (docs/architecture/design/agent-tools.md: "Auth: guest") and its own
 * guards already treat it as always-allowed, so there is no state/context
 * branch to gate on — "customer asks for a human" should never be blocked
 * by session state. The `safePlan` wrap remains the defence-in-depth
 * guarantee for every OTHER kind in this domain — a future regression
 * that adds one of THEM to the planner's advertised surface still throws
 * `PlanConformanceError` at boot.
 */

import {
  filterReadOnly,
  safePlan,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm"
import type {
  WhatsAppContext,
  WhatsAppIntentKind,
  WhatsAppState,
} from "./types.js"

/**
 * WhatsApp-domain tool classification. Every entry is MUTATING — there
 * are no LLM-visible read tools in this domain (read-side queries on
 * WhatsApp state live in the `customer` / `support` domains).
 *
 * Tool naming is the legacy `snake_case` convention from the IbateXas
 * tool registry. The Pack does not currently expose any of these to
 * the LLM directly (see module doc above) — the entries are listed so
 * `safePlan` has a complete MUTATING surface to assert against.
 */
export const WHATSAPP_TOOLS: ToolClassification = {
  READ_ONLY: new Set<string>([]),
  MUTATING: new Set<string>([
    "send_whatsapp_message",
    "send_whatsapp_template",
    "handover_whatsapp_session",
    // F5/L3 (BKL-030) — customer-side escalation on-ramp.
    "request_human_handoff",
  ]),
}

/**
 * Tool → intent-kind mapping. Empty by design — see module doc. The
 * shape is kept here so adopters who later expose a tool can extend
 * it with the same lookup convention used by `pack-orders` and
 * `pack-reservations`.
 */
export const WHATSAPP_TOOL_TO_INTENT: Readonly<
  Record<string, WhatsAppIntentKind>
> = {
  request_human_handoff: "whatsapp.handoff.request",
}

// ── Planner implementation ──────────────────────────────────────────────

/**
 * Default planner the Pack ships. Returns zero visible read tools and
 * advertises exactly one allowed intent (`whatsapp.handoff.request`,
 * FE-T14/BKL-030-activation), unconditionally — see module doc. The
 * signature is preserved so the Pack composes uniformly with
 * `pack-orders` / `pack-reservations` in the kernel's installation list.
 */
const rawWhatsappCapabilityPlanner: CapabilityPlanner<
  WhatsAppState,
  WhatsAppContext
> = {
  plan(state, context): Plan {
    // Reference the parameters so TypeScript's `noUnusedParameters` is
    // satisfied. They are intentionally not inspected — activation is
    // unconditional (see module doc).
    void state
    void context
    return {
      visibleReadTools: filterReadOnly(WHATSAPP_TOOLS, []),
      allowedIntents: ["whatsapp.handoff.request"],
    }
  },
}

/**
 * Wrapped via `safePlan` — every `plan()` invocation is asserted
 * against `WHATSAPP_TOOLS` so a future regression that adds a
 * MUTATING tool name to `visibleReadTools` throws
 * `PlanConformanceError` loudly at boot. Mirrors the pattern in
 * `pack-orders` (`ORDER_TOOLS`) and `pack-reservations`
 * (`RESERVATION_TOOLS`).
 */
export const whatsappCapabilityPlanner: CapabilityPlanner<
  WhatsAppState,
  WhatsAppContext
> = safePlan(rawWhatsappCapabilityPlanner, WHATSAPP_TOOLS)
