/**
 * @ibatexas/pack-reservations — first-party Pack for the booking / reservation domain.
 *
 * Second first-party Pack after `@ibatexas/pack-orders`. Adds policy
 * coverage for reservation create / modify / cancel, staff transitions
 * (checkin / complete), the system-only no-show marker, and waitlist
 * join / notify. Follows the `pack-orders` template per CLAUDE.md
 * rule #9 / ADR #13.
 *
 * Two adoption patterns:
 *
 *   1. Canonical-Pack-intent (recommended): import `reservationsPack`,
 *      dispatch envelopes against `reservationsPack.policy`. The
 *      Pack's intent kinds (`reservation.create`, `reservation.modify`,
 *      `reservation.cancel`, …) are the wire contract; the master
 *      taxonomy at `docs/adjudicate-migration/governance/01-intent-taxonomy.md`
 *      §"Domain: reservation" is authoritative.
 *
 *   2. Bundle-only: import `reservationsPolicyBundle` and feed to
 *      `adjudicate()` directly. Task 15's `ReservationCommandService`
 *      uses this pattern to wrap the existing
 *      `packages/domain/src/services/reservation.service.ts` calls.
 *
 * Conformance: `reservationsPack satisfies PackV0<...>`. The
 * `__tests__/conformance.test.ts` corpus pins behaviour;
 * `runConformance(reservationsPack)` from `@adjudicate/conformance`
 * runs the kernel-level invariant suite (taint protection, replay
 * determinism, basis-vocabulary purity, guard ordering, default
 * polarity).
 */

import type { PackV0 } from "@adjudicate/core"
import { reservationsCapabilityPlanner } from "./capabilities.js"
import { reservationsPolicyBundle } from "./policies.js"
import type {
  ReservationContext,
  ReservationIntentKind,
  ReservationPayload,
  ReservationState,
} from "./types.js"

// ── Rehydrator ──────────────────────────────────────────────────────────

/**
 * Reconstitute a `ReservationState` from a JSON-serializable representation.
 *
 * `Date` fields inside `ctx` (`now`, `slot.startAt`, `newSlot.startAt`)
 * don't survive `JSON.stringify` — they come back as ISO strings. This
 * rehydrator promotes them back to `Date`. All other fields pass
 * through.
 *
 * Permissive on input per the `PackV0.rehydrateState` convention:
 * malformed/missing fields fall back to empty defaults so scenario
 * fixtures and audit-replay payloads can be lenient while the policy's
 * guards remain the authoritative validators.
 */
export function rehydrateReservationState(raw: unknown): ReservationState {
  if (typeof raw !== "object" || raw === null || !("ctx" in raw)) {
    return {
      ctx: {
        channel: "web",
        customerId: null,
        staffId: null,
      },
    }
  }
  const ctxRaw = (raw as { ctx: unknown }).ctx
  if (typeof ctxRaw !== "object" || ctxRaw === null) {
    return {
      ctx: {
        channel: "web",
        customerId: null,
        staffId: null,
      },
    }
  }
  const ctx = ctxRaw as ReservationState["ctx"] & {
    now?: unknown
    slot?: unknown
    newSlot?: unknown
  }

  const toDate = (value: unknown): Date | null => {
    if (value instanceof Date) return value
    if (typeof value === "string" || typeof value === "number") {
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? null : d
    }
    return null
  }

  const rehydrateSlot = (
    value: unknown,
  ): ReservationState["ctx"]["slot"] => {
    if (typeof value !== "object" || value === null) return null
    const v = value as Record<string, unknown>
    const startAt = toDate(v.startAt)
    if (
      typeof v.timeSlotId !== "string" ||
      !startAt ||
      typeof v.maxCovers !== "number" ||
      typeof v.reservedCovers !== "number"
    ) {
      return null
    }
    return {
      timeSlotId: v.timeSlotId,
      startAt,
      maxCovers: v.maxCovers,
      reservedCovers: v.reservedCovers,
    }
  }

  return {
    ...((raw as object) || {}),
    ctx: {
      ...ctx,
      now: toDate(ctx.now) ?? null,
      slot: rehydrateSlot(ctx.slot),
      newSlot: rehydrateSlot(ctx.newSlot),
    },
  } as ReservationState
}

// ── Re-exports for adopter convenience ──────────────────────────────────

export {
  RESERVATION_CANCEL_CONFIRM_HOURS,
  RESERVATION_NO_SHOW_ESCALATE_RATE,
  reservationTaintPolicy,
  type ReservationCancelPayload,
  type ReservationCheckinPayload,
  type ReservationCompletePayload,
  type ReservationContext,
  type ReservationCreatePayload,
  type ReservationIntentKind,
  type ReservationModifyPayload,
  type ReservationNoShowMarkPayload,
  type ReservationPayload,
  type ReservationState,
  type ReservationWaitlistJoinPayload,
  type ReservationWaitlistNotifyPayload,
} from "./types.js"

export {
  refuseCustomerBlocked,
  refuseDefault,
  refuseInvalidPartySize,
  refuseNotAuthenticated,
  refuseReservationNotCancellable,
  refuseReservationNotFound,
  refuseReservationNotModifiable,
  refuseSlotFull,
  refuseSlotInPast,
  refuseSlotNotFound,
  refuseStaffOnly,
  portugueseRefusalMessages,
} from "./refusals.js"

export { reservationsPolicyBundle } from "./policies.js"

export {
  RESERVATION_TOOL_TO_INTENT,
  RESERVATION_TOOLS,
  reservationsCapabilityPlanner,
} from "./capabilities.js"

/**
 * The Pack as a `PackV0`-conformant value. The `satisfies` clause
 * provides compile-time conformance — drift from `PackV0`'s shape
 * fails the build. `intents` stays narrowly typed via the explicit
 * type parameters; the master taxonomy (governance §"Domain:
 * reservation") is the source of truth.
 *
 * Pack id convention matches `@ibatexas/pack-orders.id =
 * "ibatexas/pack-reservations"`: short, no scope prefix on the
 * `id` field itself; the npm scope lives in `package.json` only.
 */
export const reservationsPack = {
  id: "ibatexas/pack-reservations",
  version: "1.0.0",
  contract: "v0",
  intents: [
    "reservation.create",
    "reservation.modify",
    "reservation.cancel",
    "reservation.checkin",
    "reservation.complete",
    "reservation.no_show.mark",
    "reservation.waitlist.join",
  ],
  policy: reservationsPolicyBundle,
  planner: reservationsCapabilityPlanner,
  /**
   * Refusal codes the Pack's policy may emit. The M3 AaC drift check
   * (`assertPackConformance` + `withBasisAudit`) verifies that
   * runtime emissions stay inside this set; new code added in
   * `refusals.ts` MUST be added here too.
   */
  basisCodes: [
    "auth.required",
    "reservation.staff_only",
    "reservation.not_found",
    "reservation.not_modifiable",
    "reservation.not_cancellable",
    "reservation.slot.not_found",
    "reservation.slot.in_past",
    "reservation.slot.full",
    "reservation.party_size.invalid",
    "reservation.customer.blocked",
    "reservation.default.deny",
  ],
  /**
   * DEFER signal vocabulary. Empty since W2/P1-F removed the
   * `slot.released` DEFER guard (no publisher existed; see
   * decisions-log §D9). The Pack has no parked envelopes today
   * — reservation.modify against a full new slot REFUSEs at the
   * default policy instead of waiting for a release that would
   * never arrive.
   */
  signals: [],
  rehydrateState: rehydrateReservationState,
} as const satisfies PackV0<
  ReservationIntentKind,
  ReservationPayload,
  ReservationState,
  ReservationContext
>
