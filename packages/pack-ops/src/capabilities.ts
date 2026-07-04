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
 * `ops_snapshot` (NEW-032 slice B) is the ONE LLM-visible READ tool — the
 * situational snapshot (alerts + incidents + kitchen + caixa). It is advertised
 * ONLY on a STAFF session (`ctx.staffId` present); non-staff sessions get an
 * empty `visibleReadTools`. Its executor is registered on BOTH the ops conductor
 * plane (where it is reachable) AND the chat plane's read-tool map (never
 * advertised there — the chat planner pins `staffId:null` — but registered so
 * the fail-closed `readToolRosterDrift` boot gate's STAFF probe stays green).
 */

import {
  filterReadOnly,
  safePlan,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm"
import type { OpsContext, OpsIntentKind, OpsState } from "./types.js"

/** The situational-snapshot READ tool name (NEW-032 slice B). */
export const OPS_SNAPSHOT_READ_TOOL = "ops_snapshot"

/**
 * Ops-domain tool classification. `product.availability.set` is MUTATING;
 * `ops_snapshot` is the LLM-visible READ tool (staff-only advertisement).
 * `safePlan` asserts no MUTATING name ever leaks into `visibleReadTools`.
 */
export const OPS_TOOLS: ToolClassification = {
  READ_ONLY: new Set<string>([OPS_SNAPSHOT_READ_TOOL]),
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
    // `ops_snapshot` is advertised ONLY to a staff session; `filterReadOnly`
    // re-asserts it is a READ_ONLY name (never a MUTATING leak). Non-staff → [].
    return {
      visibleReadTools: isStaffSession
        ? filterReadOnly(OPS_TOOLS, [OPS_SNAPSHOT_READ_TOOL])
        : filterReadOnly(OPS_TOOLS, []),
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
