/**
 * @ibatexas/pack-reservations — PolicyBundle.
 *
 * Composed from `@adjudicate/primitives` factories
 * (`createSystemTaintPolicy`, `createConfirmGuard`, `createEscalateGuard`,
 * `createStateDeferGuard`). Default polarity is REFUSE — per master plan
 * §"Governance principles" #4 and `governance/04-decision-policy.md`
 * §"Default refuse policy".
 *
 * Guard ordering inside each phase matters. The kernel evaluation order
 * is `state → taint → auth → business` (ADR-104). The state phase here
 * carries the DEFER-on-slot-full guard so an UNTRUSTED LLM proposal
 * still gets parked rather than refused outright when the *new* slot is
 * temporarily at capacity.
 *
 * # Migrated behaviour
 *
 * The imperative logic in `packages/domain/src/services/reservation.service.ts`
 * (slot capacity check, status mutability, owner assert) is kept as-is —
 * this Pack adds the *policy* envelope around it. `ReservationCommandService`
 * (task 15) will route mutating tools through the kernel before invoking
 * the service.
 */

import {
  basis,
  BASIS_CODES,
  decisionEscalate,
  decisionExecute,
  decisionRefuse,
} from "@adjudicate/core"
import {
  nameGuard,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import {
  createConfirmGuard,
  createEscalateGuard,
  createStateDeferGuard,
} from "@adjudicate/primitives"
import {
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
} from "./refusals.js"
import {
  RESERVATION_CANCEL_CONFIRM_HOURS,
  RESERVATION_NO_SHOW_ESCALATE_RATE,
  RESERVATION_SLOT_RELEASED_SIGNAL,
  RESERVATION_SLOT_RELEASED_TIMEOUT_MS,
  reservationTaintPolicy,
  type ReservationIntentKind,
  type ReservationPayload,
  type ReservationState,
} from "./types.js"

type ReservationGuard = Guard<
  ReservationIntentKind,
  ReservationPayload,
  ReservationState
>

// ── Helpers ─────────────────────────────────────────────────────────────

function isAuthenticatedCustomer(state: ReservationState): boolean {
  return state.ctx.customerId !== null
}

function isStaff(state: ReservationState): boolean {
  return state.ctx.staffId !== null
}

const NON_MODIFIABLE_STATUSES = new Set(["cancelled", "no_show", "completed"])

function isReservationModifiable(
  reservation: NonNullable<ReservationState["ctx"]["reservation"]>,
): boolean {
  return !NON_MODIFIABLE_STATUSES.has(reservation.status)
}

function isReservationCancellable(
  reservation: NonNullable<ReservationState["ctx"]["reservation"]>,
): boolean {
  return !NON_MODIFIABLE_STATUSES.has(reservation.status)
}

function hoursUntil(slotStart: Date, now: Date): number {
  return (slotStart.getTime() - now.getTime()) / (1000 * 60 * 60)
}

const CUSTOMER_FACING_MUTATIONS: ReadonlySet<ReservationIntentKind> = new Set([
  "reservation.create",
  "reservation.modify",
  "reservation.cancel",
  "reservation.waitlist.join",
])

const STAFF_ONLY_KINDS: ReadonlySet<ReservationIntentKind> = new Set([
  "reservation.checkin",
  "reservation.complete",
])

// ── Auth guards ─────────────────────────────────────────────────────────

/**
 * Customer-touching reservation kinds require an authenticated customer
 * principal. System-only kinds (no_show.mark, waitlist.notify) bypass
 * the auth gate — the taint policy is the authority for them. Staff-
 * only kinds (checkin, complete) require staffId — checked below.
 */
const requireAuthenticated: ReservationGuard = (envelope, state) => {
  if (!CUSTOMER_FACING_MUTATIONS.has(envelope.kind)) return null
  if (isAuthenticatedCustomer(state)) return null
  return decisionRefuse(refuseNotAuthenticated(), [
    basis("auth", BASIS_CODES.auth.IDENTITY_MISSING),
  ])
}

/**
 * Staff-only kinds (`reservation.checkin`, `reservation.complete`) require
 * an authenticated staff principal — `state.ctx.staffId !== null`. A
 * customer-only session attempting these is REFUSEd with `staff_only`.
 */
const requireStaff: ReservationGuard = (envelope, state) => {
  if (!STAFF_ONLY_KINDS.has(envelope.kind)) return null
  if (isStaff(state)) return null
  return decisionRefuse(refuseStaffOnly(envelope.kind), [
    basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, {
      required: "staff",
      kind: envelope.kind,
    }),
  ])
}

// ── State guards ────────────────────────────────────────────────────────

/**
 * `reservation.create` requires a known slot with remaining capacity for
 * the requested party size. Slot data is projected into state by the
 * adopter command service (under the `FOR UPDATE` lock for serializability).
 */
const requireSlotWithCapacity: ReservationGuard = (envelope, state) => {
  if (envelope.kind !== "reservation.create") return null
  const slot = state.ctx.slot
  if (!slot) {
    return decisionRefuse(refuseSlotNotFound(), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "slot_missing",
      }),
    ])
  }
  const payload = envelope.payload as { partySize?: unknown }
  const partySize =
    typeof payload.partySize === "number" ? payload.partySize : 0
  const remaining = slot.maxCovers - slot.reservedCovers
  if (remaining < partySize) {
    return decisionRefuse(refuseSlotFull(), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "slot_full",
        partySize,
        remaining,
      }),
    ])
  }
  return null
}

/**
 * Slot must be in the future. Compares `slot.startAt` against `now`. If
 * either is missing, the guard short-circuits (`null`) — the
 * `requireSlotWithCapacity` guard catches missing-slot, and missing-`now`
 * is treated conservatively as "policy can't tell, let downstream decide".
 */
const requireSlotInFuture: ReservationGuard = (envelope, state) => {
  if (envelope.kind !== "reservation.create") return null
  const slot = state.ctx.slot
  const now = state.ctx.now
  if (!slot || !now) return null
  if (slot.startAt.getTime() > now.getTime()) return null
  return decisionRefuse(refuseSlotInPast(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "slot_in_past",
      slotStartAt: slot.startAt.toISOString(),
      now: now.toISOString(),
    }),
  ])
}

/**
 * Modify / cancel / checkin / complete / no_show.mark all read an existing
 * reservation snapshot. Reservation-not-found here is the most common
 * upstream error mode (orphaned LLM proposals, race with concurrent
 * cancel). REFUSE with a stable code so the adopter can branch on it.
 */
const MUTATION_KINDS_REQUIRING_RESERVATION: ReadonlySet<ReservationIntentKind> =
  new Set([
    "reservation.modify",
    "reservation.cancel",
    "reservation.checkin",
    "reservation.complete",
    "reservation.no_show.mark",
  ])

const requireReservationPresent: ReservationGuard = (envelope, state) => {
  if (!MUTATION_KINDS_REQUIRING_RESERVATION.has(envelope.kind)) return null
  if (state.ctx.reservation) return null
  return decisionRefuse(refuseReservationNotFound(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "reservation_missing",
    }),
  ])
}

const requireReservationModifiable: ReservationGuard = (envelope, state) => {
  if (envelope.kind !== "reservation.modify") return null
  const r = state.ctx.reservation
  if (!r) return null // covered by requireReservationPresent
  if (isReservationModifiable(r)) return null
  return decisionRefuse(refuseReservationNotModifiable(r.status), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "not_modifiable",
      status: r.status,
    }),
  ])
}

const requireReservationCancellable: ReservationGuard = (envelope, state) => {
  if (envelope.kind !== "reservation.cancel") return null
  const r = state.ctx.reservation
  if (!r) return null
  if (isReservationCancellable(r)) return null
  return decisionRefuse(refuseReservationNotCancellable(r.status), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "not_cancellable",
      status: r.status,
    }),
  ])
}

// ── DEFER on slot.released (delegated to @adjudicate/primitives) ────────

/**
 * `reservation.modify` parks on `slot.released` when the *new* slot has
 * no remaining capacity. The runtime resolver fires when a cancel or
 * no-show on that slot releases covers — at which point the kernel
 * re-adjudicates. Analogous to PIX's `payment.confirmed` DEFER.
 *
 * Notes:
 *   - This DEFER is only meaningful when the move is to a *different*
 *     slot. Same-slot modifications (just changing party size) are
 *     not parked here — the requireSlotWithCapacity logic for create
 *     does NOT apply because modify uses a separate capacity check
 *     (the existing reservation's covers are subtracted out).
 *   - We DEFER on the *new* slot's id; the resolver matches by
 *     `slot.released` signal carrying the freed slot id.
 */
const deferOnSlotFull = nameGuard(
  "deferOnSlotFull",
  createStateDeferGuard<
    ReservationIntentKind,
    ReservationPayload,
    ReservationState
  >({
    matches: (envelope, state) => {
      if (envelope.kind !== "reservation.modify") return false
      const newSlot = state.ctx.newSlot
      if (!newSlot) return false
      return newSlot.reservedCovers >= newSlot.maxCovers
    },
    signal: RESERVATION_SLOT_RELEASED_SIGNAL,
    timeoutMs: RESERVATION_SLOT_RELEASED_TIMEOUT_MS,
    basis: (envelope, state) => [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "new_slot_full",
        timeSlotId: state.ctx.newSlot?.timeSlotId,
        kind: envelope.kind,
      }),
    ],
  }),
) as ReservationGuard

// ── Business guards ─────────────────────────────────────────────────────

/**
 * Party size must be a positive integer. The slot capacity guard depends
 * on this being well-formed; this guard exists so the refusal codes stay
 * orthogonal (party-size-invalid vs slot-full).
 */
const validatePartySize: ReservationGuard = (envelope) => {
  if (
    envelope.kind !== "reservation.create" &&
    envelope.kind !== "reservation.modify" &&
    envelope.kind !== "reservation.waitlist.join"
  ) {
    return null
  }
  const payload = envelope.payload as {
    partySize?: unknown
    newPartySize?: unknown
  }
  const candidate =
    envelope.kind === "reservation.modify"
      ? payload.newPartySize
      : payload.partySize
  // `modify` permits partySize to be absent (just rescheduling) — skip.
  if (envelope.kind === "reservation.modify" && candidate === undefined) {
    return null
  }
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate <= 0
  ) {
    return decisionRefuse(refuseInvalidPartySize(candidate), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "party_size_positive_integer",
        seen: candidate,
      }),
    ])
  }
  return null
}

/**
 * REQUEST_CONFIRMATION: cancels within `RESERVATION_CANCEL_CONFIRM_HOURS`
 * of the slot start. The customer is prompted before EXECUTE.
 *
 * `extract` returns the absolute number of hours remaining; we use the
 * `<` comparator (strictly inside the window) so a cancel exactly at the
 * window boundary executes without prompting.
 *
 * If `now` or `slot.startAt` is missing, the extractor returns null and
 * the guard short-circuits — the adopter must inject `now` for this
 * guard to fire.
 */
const confirmLastMinuteCancel = nameGuard(
  "confirmLastMinuteCancel",
  createConfirmGuard<
    ReservationIntentKind,
    ReservationPayload,
    ReservationState
  >({
    matches: (env) => env.kind === "reservation.cancel",
    extract: (_env, state) => {
      const slot = state.ctx.slot
      const now = state.ctx.now
      if (!slot || !now) return null
      return hoursUntil(slot.startAt, now)
    },
    threshold: RESERVATION_CANCEL_CONFIRM_HOURS,
    comparator: "<",
    prompt: (value) =>
      `Falta(m) ${value.toFixed(1)}h pra reserva — tem certeza que quer cancelar?`,
  }),
) as ReservationGuard

/**
 * ESCALATE: `reservation.create` from a customer whose historical
 * no-show rate is above `RESERVATION_NO_SHOW_ESCALATE_RATE`. Routed to
 * `human` so a staff member can review before honoring the booking.
 */
const escalateHighNoShowRate = nameGuard(
  "escalateHighNoShowRate",
  createEscalateGuard<
    ReservationIntentKind,
    ReservationPayload,
    ReservationState
  >({
    matches: (env) => env.kind === "reservation.create",
    extract: (_env, state) => {
      const rate = state.ctx.customer?.noShowRate
      if (rate === undefined || rate === null) return null
      return rate
    },
    threshold: RESERVATION_NO_SHOW_ESCALATE_RATE,
    comparator: ">",
    to: "human",
    reason: (value) =>
      `Cliente com histórico de no-show (${(value * 100).toFixed(0)}%) — revisar antes de confirmar.`,
  }),
) as ReservationGuard

/**
 * REFUSE: customers explicitly flagged `blocked` cannot create new
 * bookings. The flag is set by staff via admin tooling — the Pack
 * surfaces it as a clean REFUSE rather than letting the create path
 * succeed and bounce downstream.
 */
const refuseBlockedCustomer: ReservationGuard = (envelope, state) => {
  if (envelope.kind !== "reservation.create") return null
  if (!state.ctx.customer?.blocked) return null
  return decisionRefuse(refuseCustomerBlocked(), [
    basis("business", BASIS_CODES.business.RULE_VIOLATED, {
      rule: "customer_blocked",
    }),
  ])
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
const executeCreate: ReservationGuard = (envelope) => {
  if (envelope.kind !== "reservation.create") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeModify: ReservationGuard = (envelope) => {
  if (envelope.kind !== "reservation.modify") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeCancel: ReservationGuard = (envelope) => {
  if (envelope.kind !== "reservation.cancel") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeStaffTransitions: ReservationGuard = (envelope) => {
  if (
    envelope.kind === "reservation.checkin" ||
    envelope.kind === "reservation.complete"
  ) {
    return decisionExecute([
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        kind: envelope.kind,
      }),
    ])
  }
  return null
}

const executeNoShow: ReservationGuard = (envelope) => {
  if (envelope.kind !== "reservation.no_show.mark") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeWaitlist: ReservationGuard = (envelope) => {
  if (
    envelope.kind === "reservation.waitlist.join" ||
    envelope.kind === "reservation.waitlist.notify"
  ) {
    return decisionExecute([
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        kind: envelope.kind,
      }),
    ])
  }
  return null
}

// ── PolicyBundle ────────────────────────────────────────────────────────

/**
 * The reservation-domain PolicyBundle. Feed to `adjudicate()` from
 * `@adjudicate/core/kernel` to decide whether to execute a proposed
 * envelope. Default is REFUSE — any kind not covered by an explicit
 * EXECUTE guard is denied by construction.
 *
 * Phase order is fixed by the kernel: `state → taint → auth →
 * business → default`.
 */
export const reservationsPolicyBundle: PolicyBundle<
  ReservationIntentKind,
  ReservationPayload,
  ReservationState
> = {
  stateGuards: [
    requireReservationPresent,
    requireReservationModifiable,
    requireReservationCancellable,
    requireSlotInFuture,
    requireSlotWithCapacity,
    deferOnSlotFull,
  ],
  authGuards: [requireAuthenticated, requireStaff],
  taint: reservationTaintPolicy,
  business: [
    validatePartySize,
    refuseBlockedCustomer,
    escalateHighNoShowRate,
    confirmLastMinuteCancel,
    executeCreate,
    executeModify,
    executeCancel,
    executeStaffTransitions,
    executeNoShow,
    executeWaitlist,
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
 * Suppress the unused-import warning for `decisionEscalate` —
 * `createEscalateGuard` consumes it internally via the primitive
 * factory; this re-export gives Pack authors a single import surface
 * if they want to compose additional escalation paths.
 *
 * Likewise `refuseDefault` is exported in case adopters want to wrap
 * their own business guard with a richer fallback refusal.
 */
export { decisionEscalate, refuseDefault }
