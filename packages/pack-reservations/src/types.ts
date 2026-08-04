/**
 * @ibatexas/pack-reservations — domain types.
 *
 * IbateXas's second first-party Pack: governs the booking / reservation
 * lifecycle (create / modify / cancel / check-in / complete / no-show /
 * waitlist join + notify). Mirrors the `pack-orders` layout so subsequent
 * Packs can keep templating off the same shape.
 *
 * Authoritative intent vocabulary: `docs/adjudicate-migration/governance/
 * 01-intent-taxonomy.md` §"Domain: reservation". The kinds enumerated
 * here track that taxonomy exactly — if a new kind appears in
 * `reservation.service.ts` or `apps/api/src/jobs/*`, update the taxonomy
 * doc FIRST.
 *
 * # Intent surface (governance §"reservation")
 *
 *   - reservation.create           — UNTRUSTED. Customer creates booking.
 *   - reservation.modify           — UNTRUSTED. Reschedule / change party
 *                                     size. REFUSEs when the new slot is
 *                                     at capacity (pre-W2 this DEFER'd on
 *                                     a never-published `slot.released`
 *                                     signal — see W2/P1-F decisions-log
 *                                     §D9 for the removal rationale).
 *   - reservation.cancel           — UNTRUSTED (or TRUSTED for staff).
 *                                     REQUEST_CONFIRMATION when within
 *                                     N hours of the slot start.
 *   - reservation.checkin          — TRUSTED (staff only). Mark seated.
 *   - reservation.complete         — TRUSTED (staff only). Close out.
 *   - reservation.no_show.mark     — SYSTEM-only (cron job at
 *                                     `apps/api/src/jobs/no-show-checker.ts`
 *                                     emits with TRUSTED taint). LLM must
 *                                     never be able to forge a no-show.
 *   - reservation.waitlist.join    — UNTRUSTED. Customer joins waitlist.
 *
 * # Source of existing logic
 *
 * `packages/domain/src/services/reservation.service.ts` carries the
 * imperative implementation today. This Pack extracts the *policy* layer
 * (eligibility / capacity / safety / confirmation) without re-implementing
 * the side effects — `ReservationCommandService` (task 15) consumes the
 * Pack's adjudication and dispatches to the existing service methods.
 */

import { createSystemTaintPolicy } from "@adjudicate/primitives"

export type ReservationIntentKind =
  // ═══ GENERATED — regenerate via `pnpm --filter @ibatexas/packs-composed run regen:intent-kinds` after editing packages/catalog/src/capability-definitions/definitions.ts. DO NOT HAND-EDIT BELOW THIS LINE. ═══
  | "reservation.create"
  | "reservation.modify"
  | "reservation.cancel"
  | "reservation.checkin"
  | "reservation.complete"
  | "reservation.no_show.mark"
  | "reservation.waitlist.join"
  // ═══ END GENERATED REGION ═══

// ── Payloads ────────────────────────────────────────────────────────────

/**
 * A reservation creation request. `partySize` is integer covers (CLAUDE.md
 * rule #2 applies to currency — this domain doesn't carry centavos at all
 * because reservations are free; the integer constraint here is structural).
 * `specialRequests` is optional and free-form per the existing
 * `reservation.service.ts:271` shape.
 */
export interface ReservationCreatePayload {
  readonly timeSlotId: string
  readonly partySize: number
  readonly specialRequests?: ReadonlyArray<string>
}

export interface ReservationModifyPayload {
  readonly reservationId: string
  readonly newTimeSlotId?: string
  readonly newPartySize?: number
  readonly specialRequests?: ReadonlyArray<string>
}

export interface ReservationCancelPayload {
  readonly reservationId: string
  readonly reason?: string
}

export interface ReservationCheckinPayload {
  readonly reservationId: string
}

export interface ReservationCompletePayload {
  readonly reservationId: string
}

export interface ReservationNoShowMarkPayload {
  readonly reservationId: string
}

export interface ReservationWaitlistJoinPayload {
  readonly timeSlotId: string
  readonly partySize: number
}

export interface ReservationWaitlistNotifyPayload {
  readonly waitlistId: string
}

/**
 * Discriminated payload union — typed by `kind`. Guards narrow via
 * `envelope.kind` and may cast `envelope.payload` to the matching
 * member; payload contracts are validated by the guards in
 * `./policies.ts` and by the wire schema upstream.
 */
export type ReservationPayload =
  | ReservationCreatePayload
  | ReservationModifyPayload
  | ReservationCancelPayload
  | ReservationCheckinPayload
  | ReservationCompletePayload
  | ReservationNoShowMarkPayload
  | ReservationWaitlistJoinPayload
  | ReservationWaitlistNotifyPayload

// ── Context (per-turn caller identity / channel surface) ────────────────

/**
 * Per-turn context the planner consumes. Mirrors the relevant slice of
 * IbateXas's session context; structurally independent from the
 * `OrderContext` shipped by `@ibatexas/pack-orders` so the planner here
 * doesn't accidentally couple to the order domain.
 */
export interface ReservationContext {
  readonly channel: "whatsapp" | "web" | "staff"
  readonly customerId: string | null
  /** Staff principal — distinct from customerId, present only for `staff` channel. */
  readonly staffId: string | null
}

// ── State (per-session snapshot the kernel adjudicates against) ─────────

/**
 * Per-session state the Pack's policies inspect. Adopters embed this into
 * their session context shape. Fields here track exactly what
 * `reservation.service.ts` reads off the DB at decision time — the Pack
 * does not pull from Prisma directly, the adopter projects state in.
 *
 * Time fields:
 *   - `now` is the wall-clock the policy compares against. Adopter supplies
 *     it (injection point for deterministic tests + audit replay). When
 *     omitted, guards short-circuit conservatively (i.e., not in the past).
 *   - `slot.startAt` is the slot's absolute start time as `Date`.
 *
 * Customer fields:
 *   - `customer.noShowRate` is a 0–1 fraction (e.g., 0.3 = 30%). Sourced
 *     from `reservation.service.ts` analytics. Optional — absence means
 *     "no history, treat as 0".
 *
 * Capacity fields:
 *   - `slot.maxCovers` / `slot.reservedCovers` mirror `TimeSlot` columns
 *     locked under `FOR UPDATE` at command time.
 *   - `newSlot` is populated when the intent is `reservation.modify` AND
 *     the customer is moving to a different slot. When populated AND
 *     `newSlot.reservedCovers === newSlot.maxCovers`, the modify falls
 *     through to the default REFUSE (the slot.released DEFER guard was
 *     removed in W2; see decisions-log §D9).
 */
export interface ReservationState {
  readonly ctx: ReservationContext & {
    /** Tenant this request operates on (AuthReviewer-009 / RC-A1 D-12). Single-tenant
     *  today; the `requireTenantBinding` authGuard REFUSEs a mismatch, no-op when absent. */
    readonly tenantId?: string
    /** Wall-clock snapshot. Injected by the adopter; required for time-comparison guards. */
    readonly now?: Date | null
    readonly slot?: {
      readonly timeSlotId: string
      readonly startAt: Date
      readonly maxCovers: number
      readonly reservedCovers: number
    } | null
    /** Populated only when the intent is reservation.modify and moving slots. */
    readonly newSlot?: {
      readonly timeSlotId: string
      readonly startAt: Date
      readonly maxCovers: number
      readonly reservedCovers: number
    } | null
    /** Existing reservation snapshot — populated for modify / cancel / checkin / complete / no_show. */
    readonly reservation?: {
      readonly id: string
      readonly status:
        | "pending"
        | "confirmed"
        | "seated"
        | "completed"
        | "cancelled"
        | "no_show"
      readonly partySize: number
      readonly timeSlotId: string
    } | null
    readonly customer?: {
      readonly id?: string
      /** 0–1. Optional — absent means "no signal". */
      readonly noShowRate?: number
      /** Whether the customer principal is blocked from making bookings. */
      readonly blocked?: boolean
    } | null
  }
}

// ── Taint policy ────────────────────────────────────────────────────────

/**
 * Customer-initiated kinds tolerate UNTRUSTED (LLM-proposable; the policy
 * decides). `reservation.no_show.mark` is the canonical example of a
 * SYSTEM-only kind — only the no-show-checker cron at
 * `apps/api/src/jobs/no-show-checker.ts` may emit it, with TRUSTED taint.
 *
 * `reservation.checkin` and `reservation.complete` are staff-only kinds
 * — the auth guard enforces `staffId !== null`, but they remain
 * UNTRUSTED-tolerant at the taint layer (a misconfigured client could
 * propose them; the auth + state guards catch the abuse).
 */
export const reservationTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: ["reservation.no_show.mark"],
  userMinimum: "UNTRUSTED",
})

// ── Business thresholds (env-driven; CLAUDE.md rule #3) ─────────────────

/**
 * REQUEST_CONFIRMATION trigger window for last-minute cancels. The default
 * matches the task spec (2 hours); operators override via
 * `RESERVATION_CANCEL_CONFIRM_HOURS`. Centavos do not apply here —
 * reservations are free.
 */
function readPositiveNumber(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined || envValue === "") return fallback
  const n = Number.parseFloat(envValue)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

export const RESERVATION_CANCEL_CONFIRM_HOURS = readPositiveNumber(
  process.env.RESERVATION_CANCEL_CONFIRM_HOURS,
  2,
)

/**
 * ESCALATE trigger on `reservation.create` from customers with high
 * historical no-show rate. `0.3` (30%) by default; override via
 * `RESERVATION_NO_SHOW_ESCALATE_RATE`. Fraction in [0, 1].
 */
export const RESERVATION_NO_SHOW_ESCALATE_RATE = readPositiveNumber(
  process.env.RESERVATION_NO_SHOW_ESCALATE_RATE,
  0.3,
)

// ── DEFER signal vocabulary — REMOVED ───────────────────────────────────
//
// Per W2 / P1-F (audit 03 §"slot.released") and decisions-log §D9: the
// `slot.released` signal had no publisher anywhere in the codebase, so
// any parked `reservation.modify` envelope would silently TTL out after
// 30 minutes with no resolution. Removed to eliminate dead code; can
// re-land cleanly when modify-on-slot-released is genuinely on the
// roadmap (publisher + subscriber + end-to-end tests).
