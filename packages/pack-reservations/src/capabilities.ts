/**
 * @ibatexas/pack-reservations — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool visibility for the reservation domain. The LLM never
 * sees MUTATING tools (CLAUDE.md rule #9); MUTATING calls are captured
 * as `IntentEnvelope`s and adjudicated through the kernel. The planner
 * here decides which READ_ONLY tools the LLM may call and which intent
 * kinds it may propose per session context.
 *
 * The full state-aware planner lives in
 * `packages/llm-provider/src/capability-planner.ts` because it depends
 * on IbateXas's state-machine vocabulary (`stateValue` strings). This
 * file ships a context-only planner that is the Pack-shipped default —
 * adopters who don't have a state machine call this one; adopters who
 * do (IbateXas's API) compose their state-aware planner over this and
 * keep the Pack's `ToolClassification` as the source of truth for
 * tool-name → mutating/read-only mapping.
 *
 * Following the `pack-payments-pix` and `pack-orders` pattern:
 * `reservationsCapabilityPlanner` is wrapped in `safePlan` so any
 * future regression that exposes a MUTATING tool to the LLM throws
 * `PlanConformanceError` at boot rather than silently leaking.
 */

import {
  filterReadOnly,
  safePlan,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm"
import type {
  ReservationContext,
  ReservationIntentKind,
  ReservationState,
} from "./types.js"

/**
 * Reservation-domain tool classification. Mirrors the reservation-related
 * entries in `packages/llm-provider/src/machine/types.ts`
 * `TOOL_CLASSIFICATION` — kept narrow to just this Pack's surface so the
 * planner's `safePlan` wrap can assert "no MUTATING tool ever appears in
 * `visibleReadTools`".
 *
 * Tool naming is the legacy `snake_case` from the IbateXas tool registry
 * (`packages/tools/src/reservation/*.ts`); the eventual
 * `@adjudicate/tools` migration will introduce versioned schemas without
 * changing the planner contract.
 */
export const RESERVATION_TOOLS: ToolClassification = {
  READ_ONLY: new Set([
    "check_availability",
    "get_my_reservations",
  ]),
  MUTATING: new Set([
    "create_reservation",
    "modify_reservation",
    "cancel_reservation",
    "join_waitlist",
  ]),
}

/**
 * Tool → intent-kind mapping for the reservation domain. The
 * intent-bridge consumes this when translating an LLM-proposed tool
 * call into an `IntentEnvelope` for adjudication. Kept beside
 * `RESERVATION_TOOLS` so "what gates this tool?" is one lookup.
 *
 * Note: only the 4 customer-facing tools are listed. Staff-only kinds
 * (`reservation.checkin`, `reservation.complete`) and the SYSTEM-only
 * kind (`reservation.no_show.mark`) have no LLM-callable tool entry —
 * they're invoked directly by staff endpoints and cron jobs respectively.
 */
export const RESERVATION_TOOL_TO_INTENT: Readonly<
  Record<string, ReservationIntentKind>
> = {
  create_reservation: "reservation.create",
  modify_reservation: "reservation.modify",
  cancel_reservation: "reservation.cancel",
  join_waitlist: "reservation.waitlist.join",
}

// ── Planner implementation ──────────────────────────────────────────────

/**
 * Default planner the Pack ships. Returns the Pack's read-only tool
 * surface, gated by the auth state in `ReservationContext`. Adopters
 * with a richer state shape (IbateXas's `stateValue`-keyed
 * `STATE_TOOLS` lookup) compose this planner via wrapper or replace
 * it outright in `installPack(reservationsPack, ...)`.
 */
const rawReservationsCapabilityPlanner: CapabilityPlanner<
  ReservationState,
  ReservationContext
> = {
  plan(state, context): Plan {
    const isAuthenticated = state.ctx.customerId !== null
    const isStaffSession = state.ctx.staffId !== null

    const baseRead: string[] = ["check_availability"]
    if (isAuthenticated || isStaffSession) {
      baseRead.push("get_my_reservations")
    }

    const allowedIntents: ReservationIntentKind[] = []
    if (isAuthenticated) {
      // Customer-facing kinds — the policy decides whether to refuse.
      allowedIntents.push(
        "reservation.create",
        "reservation.modify",
        "reservation.cancel",
        "reservation.waitlist.join",
      )
    }
    if (isStaffSession) {
      allowedIntents.push("reservation.checkin", "reservation.complete")
    }
    // `reservation.no_show.mark` is NEVER LLM-proposable — the taint gate
    // enforces TRUSTED for system-only kinds (see types.ts taint policy);
    // the planner omits it for defence in depth.
    void context

    return {
      visibleReadTools: filterReadOnly(RESERVATION_TOOLS, baseRead),
      allowedIntents,
    }
  },
}

/**
 * Wrapped via `safePlan` — every `plan()` invocation is asserted
 * against `RESERVATION_TOOLS` so a future regression that adds a
 * MUTATING tool name to `visibleReadTools` throws
 * `PlanConformanceError` loudly at boot. This is the recommended
 * pattern for every Pack; `pack-payments-pix` does the same with
 * `PIX_TOOLS`, `pack-orders` with `ORDER_TOOLS`.
 */
export const reservationsCapabilityPlanner: CapabilityPlanner<
  ReservationState,
  ReservationContext
> = safePlan(rawReservationsCapabilityPlanner, RESERVATION_TOOLS)
