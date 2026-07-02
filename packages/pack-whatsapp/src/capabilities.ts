/**
 * @ibatexas/pack-whatsapp — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool visibility for the WhatsApp egress domain. The LLM
 * never sees MUTATING tools (CLAUDE.md rule #9); MUTATING calls are
 * captured as `IntentEnvelope`s and adjudicated through the kernel.
 *
 * This Pack's MUTATING surface is wholly LLM-invisible. The WhatsApp
 * channel-level intents (`whatsapp.message.send`,
 * `whatsapp.template.send`, `whatsapp.session.handover`) are emitted
 * by:
 *
 *   - the `cart-intelligence` NATS subscriber (templated outreach),
 *   - the `handoff-subscriber` (session handover),
 *   - the `notification.send` subscriber (templated customer messages),
 *
 * none of which are LLM-proposable. The LLM's only relationship to
 * this domain is INDIRECT, via `handoff_to_human` — which is gated by
 * the `support` Pack (future work) rather than this one.
 *
 * The planner here therefore exposes ZERO MUTATING intents to the LLM
 * by construction; `allowedIntents` returns an empty list for every
 * session context. The `safePlan` wrap is the defence-in-depth
 * guarantee — a future regression that adds a kind to the planner's
 * MUTATING surface throws `PlanConformanceError` at boot.
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
 * zero allowed intents — see module doc. The signature is preserved so
 * the Pack composes uniformly with `pack-orders` / `pack-reservations`
 * in the kernel's installation list.
 */
const rawWhatsappCapabilityPlanner: CapabilityPlanner<
  WhatsAppState,
  WhatsAppContext
> = {
  plan(state, context): Plan {
    // Reference the parameters so TypeScript's `noUnusedParameters` is
    // satisfied. They are intentionally not inspected.
    void state
    void context
    return {
      visibleReadTools: filterReadOnly(WHATSAPP_TOOLS, []),
      // F5/L3 (BKL-030): the governed `whatsapp.handoff.request` intent is
      // fully wired (registered, policied, adjudicable) but NOT yet advertised
      // to the LLM — advertising it changes the express_intent surface, which
      // invalidates the content-addressed golden-conversation fixtures
      // (scripted-pipeline). Activation = advertise here + regenerate those
      // fixtures (BKL-030-activation), the same registered-but-unadvertised
      // pattern `order.review.submit` uses.
      allowedIntents: [],
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
