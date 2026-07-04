/**
 * @ibatexas/pack-ops — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool/intent visibility for the ops plane. The LLM never sees
 * MUTATING tools (CLAUDE.md rule #9); MUTATING calls are captured as
 * `IntentEnvelope`s and adjudicated by the kernel.
 *
 * `product.availability.set` is advertised as an `allowedIntent` ONLY on a
 * STAFF session (`ctx.staffId` present) — the ops persona. It is NEVER a
 * customer/LLM chat verb, so it is deliberately absent from
 * `CHAT_DRIVABLE_TOOL_KINDS` and has no registered chat tool (it shows up as
 * advertised-but-unregistered under the `staff` roster-drift probe, which the
 * `ADVERTISED_NOT_REGISTERED_WHITELIST` documents).
 *
 * `visibleReadTools` is empty for now: the ops-snapshot READ tool is wired in
 * the later conductor PR. Advertising a read with no executor would fail the
 * `readToolRosterDrift` boot gate closed, so it stays out until its executor
 * lands.
 */

import {
  filterReadOnly,
  safePlan,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm"
import type { OpsContext, OpsIntentKind, OpsState } from "./types.js"

/**
 * Ops-domain tool classification. `product.availability.set` is MUTATING;
 * there are no LLM-visible read tools yet. `safePlan` asserts no MUTATING
 * name ever leaks into `visibleReadTools`.
 */
export const OPS_TOOLS: ToolClassification = {
  READ_ONLY: new Set<string>([]),
  MUTATING: new Set<string>(["product.availability.set"]),
}

// ── Planner implementation ──────────────────────────────────────────────────

/**
 * Default planner the Pack ships. Advertises the ops verb ONLY on a staff
 * session; every non-staff (customer / LLM / unauthenticated) session gets an
 * empty `allowedIntents`. Mirrors `pack-reservations`' staff-gated planner.
 */
const rawOpsCapabilityPlanner: CapabilityPlanner<OpsState, OpsContext> = {
  plan(state, context): Plan {
    // `context` is required by the contract but not inspected — the staff
    // gate reads the projected session state, like the other packs.
    void context
    // Collapse an absent (undefined) staffId to null so BOTH null and
    // undefined mean "not a staff session".
    const staffId = state.ctx.staffId ?? null
    const isStaffSession = staffId !== null
    const allowedIntents: OpsIntentKind[] = isStaffSession
      ? ["product.availability.set"]
      : []
    return {
      visibleReadTools: filterReadOnly(OPS_TOOLS, []),
      allowedIntents,
    }
  },
}

/**
 * Wrapped via `safePlan` — every `plan()` invocation is asserted against
 * `OPS_TOOLS` so a future regression that adds a MUTATING tool name to
 * `visibleReadTools` throws `PlanConformanceError` at boot. Mirrors
 * `pack-orders` (`ORDER_TOOLS`) / `pack-reservations` (`RESERVATION_TOOLS`).
 */
export const opsCapabilityPlanner: CapabilityPlanner<OpsState, OpsContext> =
  safePlan(rawOpsCapabilityPlanner, OPS_TOOLS)
