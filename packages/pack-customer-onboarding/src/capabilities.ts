/**
 * @ibatexas/pack-customer-onboarding — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool visibility for the customer-identity domain. The LLM
 * never sees MUTATING tools (CLAUDE.md rule #9); MUTATING calls are
 * captured as `IntentEnvelope`s and adjudicated through the kernel.
 * The planner here decides which READ_ONLY tools the LLM may call and
 * which intent kinds it may propose per session context.
 *
 * # LLM-callable surface
 *
 * Only two MUTATING tools in this Pack are reachable from the LLM
 * tool path:
 *
 *   - `update_preferences`   (`customer.preferences.update`)
 *   - `save_pix_details`     (`customer.pix.details.save`)
 *
 * The destructive flow (`customer.anonymize`, `customer.anonymize.cancel`)
 * is NEVER LLM-callable. Task 14's HTTP routes are the only emission
 * point — the planner omits these kinds from `allowedIntents` regardless
 * of state. Same for `customer.create` (SYSTEM-only, OTP-flow-seeded)
 * and `customer.address.*` (currently web-only, no LLM tool).
 *
 * # Pattern
 *
 * Following `pack-payments-pix` and `pack-orders`: the planner is
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
  CustomerOnboardingContext,
  CustomerOnboardingIntentKind,
  CustomerOnboardingState,
} from "./types.js"

/**
 * Customer-domain tool classification. Mirrors the customer-related
 * entries in `packages/llm-provider/src/machine/types.ts`
 * `TOOL_CLASSIFICATION` — kept narrow to just this Pack's surface so
 * the planner's `safePlan` wrap can assert "no MUTATING tool ever
 * appears in `visibleReadTools`".
 *
 * Tool naming is the legacy `snake_case` from the IbateXas tool
 * registry (`packages/tools/src/intelligence/update-preferences.ts`,
 * `packages/tools/src/payments/save-pix-details.ts`); the eventual
 * `@adjudicate/tools` migration will introduce versioned schemas
 * without changing the planner contract.
 */
export const CUSTOMER_ONBOARDING_TOOLS: ToolClassification = {
  READ_ONLY: new Set([
    "get_my_profile",
    "get_my_preferences",
  ]),
  MUTATING: new Set([
    "update_preferences",
    "save_pix_details",
  ]),
}

/**
 * Tool → intent-kind mapping for the customer-identity domain. The
 * intent-bridge consumes this when translating an LLM-proposed tool
 * call into an `IntentEnvelope` for adjudication. Kept beside
 * `CUSTOMER_ONBOARDING_TOOLS` so "what gates this tool?" is one lookup.
 *
 * Note: only the 2 LLM-callable mutating tools are listed.
 *   - `customer.create`                  — SYSTEM-only (OTP-flow seed)
 *   - `customer.profile.update`          — web/admin only, no LLM tool
 *   - `customer.address.add` / .remove    — web/admin only, no LLM tool
 *   - `customer.anonymize` / .cancel      — HTTP-only (task 14)
 *
 * Each of those kinds has no LLM-callable tool entry — they're invoked
 * directly by route handlers, never proposed via the LLM tool path.
 */
export const CUSTOMER_ONBOARDING_TOOL_TO_INTENT: Readonly<
  Record<string, CustomerOnboardingIntentKind>
> = {
  update_preferences: "customer.preferences.update",
  save_pix_details: "customer.pix.details.save",
}

// ── Planner implementation ──────────────────────────────────────────────

/**
 * Default planner the Pack ships. Returns the Pack's read-only tool
 * surface, gated by the auth state in `CustomerOnboardingContext`.
 * Adopters with a richer state shape (IbateXas's `stateValue`-keyed
 * `STATE_TOOLS` lookup) compose this planner via wrapper or replace it
 * outright in `installPack(customerOnboardingPack, ...)`.
 *
 * Read-only tools (`get_my_profile`, `get_my_preferences`) are shown
 * only to authenticated principals — there's no anonymous read path
 * for personal data.
 */
const rawCustomerOnboardingCapabilityPlanner: CapabilityPlanner<
  CustomerOnboardingState,
  CustomerOnboardingContext
> = {
  plan(state, context): Plan {
    const isAuthenticated = state.ctx.isAuthenticated

    const baseRead: string[] = []
    if (isAuthenticated) {
      baseRead.push("get_my_profile", "get_my_preferences")
    }

    const allowedIntents: CustomerOnboardingIntentKind[] = []
    if (isAuthenticated) {
      // LLM-callable customer-actor kinds. The policy decides whether
      // to honor; the planner just lists what's *proposable*. Note the
      // destructive flow (`customer.anonymize.*`) and SYSTEM-only kind
      // (`customer.create`) are NEVER in this list — they're emitted
      // by the route layer directly.
      allowedIntents.push(
        "customer.preferences.update",
        "customer.pix.details.save",
      )
    }
    void context

    return {
      visibleReadTools: filterReadOnly(CUSTOMER_ONBOARDING_TOOLS, baseRead),
      allowedIntents,
    }
  },
}

/**
 * Wrapped via `safePlan` — every `plan()` invocation is asserted
 * against `CUSTOMER_ONBOARDING_TOOLS` so a future regression that adds
 * a MUTATING tool name to `visibleReadTools` throws
 * `PlanConformanceError` loudly at boot. This is the recommended
 * pattern for every Pack; `pack-payments-pix` does the same with
 * `PIX_TOOLS`, `pack-orders` with `ORDER_TOOLS`,
 * `pack-reservations` with `RESERVATION_TOOLS`.
 */
export const customerOnboardingCapabilityPlanner: CapabilityPlanner<
  CustomerOnboardingState,
  CustomerOnboardingContext
> = safePlan(rawCustomerOnboardingCapabilityPlanner, CUSTOMER_ONBOARDING_TOOLS)
