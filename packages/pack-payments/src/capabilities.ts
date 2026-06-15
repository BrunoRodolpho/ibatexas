/**
 * @ibatexas/pack-payments — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool visibility for the payment domain. Most payment
 * operations are NOT LLM-proposable — they originate from webhooks
 * (Stripe), cron jobs (PIX expiry, stale order), or staff routes
 * (admin refund / cash confirm / waive). The LLM never holds the
 * authority to confirm a charge, issue a refund, or open a dispute.
 *
 * The customer-driven kinds (`payment.pix.regenerate`,
 * `payment.method.switch`, `payment.retry`) ARE LLM-proposable via
 * tool calls; their MUTATING classification ensures the LLM never
 * sees them as visible-read tools.
 *
 * Following the `pack-orders` pattern: `paymentsCapabilityPlanner` is
 * wrapped in `safePlan` so any future regression that exposes a
 * MUTATING tool to the LLM throws `PlanConformanceError` at boot
 * rather than silently leaking.
 */

import {
  filterReadOnly,
  safePlan,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm"
import type {
  PaymentContext,
  PaymentIntentKind,
  PaymentState,
} from "./types.js"

/**
 * Payment-domain tool classification.
 *
 * Tool naming is the legacy `snake_case` from the IbateXas tool
 * registry. The customer-driven mutating tools route through the
 * intent-bridge to the matching `payment.*` envelope.
 */
export const PAYMENT_TOOLS: ToolClassification = {
  READ_ONLY: new Set([
    "get_payment_status",
    "get_payment_history",
  ]),
  MUTATING: new Set([
    "regenerate_pix",
    "switch_payment_method",
    "retry_payment",
  ]),
}

/**
 * Tool → intent-kind mapping for the payment domain. The intent-bridge
 * consumes this when translating an LLM-proposed tool call into an
 * `IntentEnvelope` for adjudication.
 */
export const PAYMENT_TOOL_TO_INTENT: Readonly<
  Record<string, PaymentIntentKind>
> = {
  regenerate_pix: "payment.pix.regenerate",
  switch_payment_method: "payment.method.switch",
  retry_payment: "payment.retry",
}

// ── Planner implementation ──────────────────────────────────────────────

/**
 * Default planner the Pack ships. Payment-domain context is tiny —
 * the planner exposes a small set of read tools (status + history) and
 * the three customer-driven intent kinds. Webhook / cron / staff kinds
 * are never LLM-proposable.
 */
const rawPaymentsCapabilityPlanner: CapabilityPlanner<PaymentState, PaymentContext> = {
  plan(state, context): Plan {
    void context
    void state

    const baseRead: string[] = ["get_payment_status", "get_payment_history"]

    // Customer-driven intent kinds the LLM may propose. The taint policy
    // gates SYSTEM-only kinds; the planner additionally narrows the
    // LLM-proposable surface.
    const allowedIntents: PaymentIntentKind[] = [
      "payment.pix.regenerate",
      "payment.method.switch",
      "payment.retry",
    ]

    return {
      visibleReadTools: filterReadOnly(PAYMENT_TOOLS, baseRead),
      allowedIntents,
    }
  },
}

/**
 * Wrapped via `safePlan` — every `plan()` invocation is asserted
 * against `PAYMENT_TOOLS` so a future regression that adds a MUTATING
 * tool name to `visibleReadTools` throws `PlanConformanceError`
 * loudly at boot.
 */
export const paymentsCapabilityPlanner: CapabilityPlanner<
  PaymentState,
  PaymentContext
> = safePlan(rawPaymentsCapabilityPlanner, PAYMENT_TOOLS)
