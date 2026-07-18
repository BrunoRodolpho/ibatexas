/**
 * @ibatexas/pack-reservations — per-guard unit tests.
 *
 * Each guard tested in isolation: input → expected decision.
 *
 * Companion to `conformance.test.ts` (kernel invariants + 25+ corpus
 * fixtures). This file targets readability of each guard's behaviour
 * for future Pack maintainers; the conformance file targets the
 * cross-outcome / kind matrix.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  reservationsPack,
  reservationsPolicyBundle,
  type ReservationIntentKind,
  type ReservationPayload,
  type ReservationState,
} from "../index.js"

const DET_TIME = "2026-05-22T12:00:00.000Z"

function env(
  kind: ReservationIntentKind,
  payload: Record<string, unknown>,
  taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "UNTRUSTED",
): IntentEnvelope<ReservationIntentKind, ReservationPayload> {
  return buildEnvelope({
    kind,
    payload: payload as unknown as ReservationPayload,
    actor: { principal: "llm", sessionId: "s-1" },
    taint,
    nonce: "n-test",
    createdAt: DET_TIME,
  })
}

function baseState(
  overrides: Partial<ReservationState["ctx"]> = {},
): ReservationState {
  return {
    ctx: {
      channel: "whatsapp",
      customerId: "c-1",
      staffId: null,
      now: new Date("2026-05-22T12:00:00.000Z"),
      slot: {
        timeSlotId: "ts-1",
        startAt: new Date("2026-05-22T20:00:00.000Z"), // 8 hours in the future
        maxCovers: 40,
        reservedCovers: 10,
      },
      newSlot: null,
      reservation: null,
      customer: { id: "c-1", noShowRate: 0 },
      ...overrides,
    },
  }
}

// ── Slot capacity (create) ──────────────────────────────────────────────

describe("reservationsPolicyBundle — slot capacity for reservation.create", () => {
  it("REFUSE reservation.create when slot is at capacity", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 4,
      }),
      baseState({
        slot: {
          timeSlotId: "ts-1",
          startAt: new Date("2026-05-22T20:00:00.000Z"),
          maxCovers: 40,
          reservedCovers: 40,
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.slot.full")
  })

  it("REFUSE reservation.create when slot is in the past", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 2,
      }),
      baseState({
        now: new Date("2026-05-22T22:00:00.000Z"),
        slot: {
          timeSlotId: "ts-1",
          startAt: new Date("2026-05-22T20:00:00.000Z"),
          maxCovers: 40,
          reservedCovers: 10,
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.slot.in_past")
  })

  it("EXECUTE reservation.create when slot has capacity and is in the future", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 4,
      }),
      baseState(),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── BKL-174 — ambiguous NL-grounded slot → disambiguation CLARIFY ────────

describe("reservationsPolicyBundle — BKL-174 ambiguous-slot CLARIFY", () => {
  it("REFUSE reservation.create voicing the candidate times when the slot is ambiguous", () => {
    const decision = adjudicate(
      env("reservation.create", {
        partySize: 4,
        slotAmbiguousCount: 3,
        slotAmbiguousTimes: ["18:30", "20:00", "21:30"],
      }),
      // Ambiguous grounding leaves the slot UNSTAMPED → ctx.slot is null; WITHOUT
      // BKL-174 the bundle REFUSEs slot.not_found. The new guard fires FIRST.
      baseState({ slot: null }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.slot.ambiguous")
    // Names the first-party candidate times, pt-BR formatted (on-the-hour → "20h").
    expect(decision.refusal.userFacing).toContain("18h30")
    expect(decision.refusal.userFacing).toContain("20h")
    expect(decision.refusal.userFacing).toContain("21h30")
  })

  it("REFUSE reservation.waitlist.join voicing the candidate times (kind coverage)", () => {
    const decision = adjudicate(
      env("reservation.waitlist.join", {
        partySize: 2,
        slotAmbiguousCount: 2,
        slotAmbiguousTimes: ["19:00", "20:30"],
      }),
      baseState({ slot: null }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.slot.ambiguous")
    expect(decision.refusal.userFacing).toContain("19h")
    expect(decision.refusal.userFacing).toContain("20h30")
  })

  // NON-VACUOUS: without the ambiguity marker, a missing slot REFUSEs slot.not_found
  // (the guard is scoped to the marker; dropping it from stateGuards restores this).
  it("does NOT fire without the ambiguity marker (missing slot → slot.not_found)", () => {
    const decision = adjudicate(
      env("reservation.create", { partySize: 4 }),
      baseState({ slot: null }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.slot.not_found")
  })
})

// ── REQUEST_CONFIRMATION on last-minute cancel ──────────────────────────

describe("reservationsPolicyBundle — REQUEST_CONFIRMATION on last-minute cancel", () => {
  it("EXECUTE reservation.cancel when slot is more than RESERVATION_CANCEL_CONFIRM_HOURS away", () => {
    const decision = adjudicate(
      env("reservation.cancel", { reservationId: "r-1" }),
      baseState({
        // 3h until slot start — outside the 2h confirm window.
        now: new Date("2026-05-22T17:00:00.000Z"),
        slot: {
          timeSlotId: "ts-1",
          startAt: new Date("2026-05-22T20:00:00.000Z"),
          maxCovers: 40,
          reservedCovers: 10,
        },
        reservation: {
          id: "r-1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts-1",
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REQUEST_CONFIRMATION on reservation.cancel within the confirm window", () => {
    const decision = adjudicate(
      env("reservation.cancel", { reservationId: "r-1" }),
      baseState({
        // 1h until slot — inside the 2h confirm window.
        now: new Date("2026-05-22T19:00:00.000Z"),
        slot: {
          timeSlotId: "ts-1",
          startAt: new Date("2026-05-22T20:00:00.000Z"),
          maxCovers: 40,
          reservedCovers: 10,
        },
        reservation: {
          id: "r-1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts-1",
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toMatch(/cancelar/i)
  })
})

// ── ESCALATE on high no-show rate ───────────────────────────────────────

describe("reservationsPolicyBundle — ESCALATE on high no-show rate", () => {
  it("ESCALATE reservation.create when customer noShowRate exceeds threshold", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 2,
      }),
      baseState({
        customer: { id: "c-1", noShowRate: 0.5 },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
    if (decision.kind !== "ESCALATE") return
    expect(decision.to).toBe("human")
  })

  it("EXECUTE reservation.create when noShowRate is at-or-below threshold", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 2,
      }),
      baseState({
        customer: { id: "c-1", noShowRate: 0.1 },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── [W2/P1-F] slot.released REMOVED — modify against full new slot REFUSEs ──
//
// Pre-W2 a `reservation.modify` against a full new slot DEFER'd on the
// `slot.released` signal — but no publisher ever fired that signal, so
// the parked envelope silently TTL'd after 30 minutes. Now the policy
// falls through to default REFUSE (the customer gets a meaningful
// rejection instead of a stuck wait). See decisions-log §D9.

describe("reservationsPolicyBundle — modify against full new slot (post P1-F removal)", () => {
  it("REFUSE reservation.modify when the new slot is at capacity (no more DEFER)", () => {
    const decision = adjudicate(
      env("reservation.modify", {
        reservationId: "r-1",
        newTimeSlotId: "ts-2",
      }),
      baseState({
        reservation: {
          id: "r-1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts-1",
        },
        newSlot: {
          timeSlotId: "ts-2",
          startAt: new Date("2026-05-22T21:00:00.000Z"),
          maxCovers: 40,
          reservedCovers: 40,
        },
      }),
      reservationsPolicyBundle,
    )
    // Pre-W2: DEFER on "slot.released" (with no resolver). Post-W2:
    // REFUSE — the customer gets a clear "slot full" rejection instead
    // of a silent timeout.
    expect(decision.kind).toBe("REFUSE")
  })

  it("EXECUTE reservation.modify when the new slot has capacity", () => {
    const decision = adjudicate(
      env("reservation.modify", {
        reservationId: "r-1",
        newTimeSlotId: "ts-2",
        newPartySize: 4,
      }),
      baseState({
        reservation: {
          id: "r-1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts-1",
        },
        newSlot: {
          timeSlotId: "ts-2",
          startAt: new Date("2026-05-22T21:00:00.000Z"),
          maxCovers: 40,
          reservedCovers: 20,
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Taint policy: system-only kinds ─────────────────────────────────────

describe("reservationsPolicyBundle — taint policy for system-only kinds", () => {
  it("system-only kinds require TRUSTED taint", () => {
    expect(
      reservationsPolicyBundle.taint.minimumFor("reservation.no_show.mark"),
    ).toBe("TRUSTED")
    expect(
      reservationsPolicyBundle.taint.minimumFor("reservation.create"),
    ).toBe("UNTRUSTED")
  })

  it("EXECUTE reservation.no_show.mark with TRUSTED taint", () => {
    const decision = adjudicate(
      env("reservation.no_show.mark", { reservationId: "r-1" }, "TRUSTED"),
      baseState({
        reservation: {
          id: "r-1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts-1",
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE UNTRUSTED reservation.no_show.mark (taint gate blocks)", () => {
    const decision = adjudicate(
      env("reservation.no_show.mark", { reservationId: "r-1" }, "UNTRUSTED"),
      baseState({
        reservation: {
          id: "r-1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts-1",
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})

// ── Auth ────────────────────────────────────────────────────────────────

describe("reservationsPolicyBundle — auth guards", () => {
  it("REFUSE customer-facing kind without customerId", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 2,
      }),
      baseState({ customerId: null, channel: "web" }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("auth.required")
  })

  it("REFUSE staff-only kind without staffId", () => {
    const decision = adjudicate(
      env("reservation.checkin", { reservationId: "r-1" }, "TRUSTED"),
      baseState({
        staffId: null,
        reservation: {
          id: "r-1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts-1",
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.staff_only")
  })

  it("EXECUTE staff-only kind with staffId present", () => {
    const decision = adjudicate(
      env("reservation.checkin", { reservationId: "r-1" }, "TRUSTED"),
      baseState({
        channel: "staff",
        staffId: "staff-1",
        reservation: {
          id: "r-1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts-1",
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── State: reservation snapshot required ────────────────────────────────

describe("reservationsPolicyBundle — reservation snapshot required", () => {
  it("REFUSE reservation.cancel without a reservation snapshot", () => {
    const decision = adjudicate(
      env("reservation.cancel", { reservationId: "r-1" }),
      baseState({ reservation: null }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.not_found")
  })

  it("REFUSE reservation.modify on a terminal reservation", () => {
    const decision = adjudicate(
      env("reservation.modify", {
        reservationId: "r-1",
        newPartySize: 4,
      }),
      baseState({
        reservation: {
          id: "r-1",
          status: "cancelled",
          partySize: 2,
          timeSlotId: "ts-1",
        },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.not_modifiable")
  })
})

// ── Business: party size validation ─────────────────────────────────────

describe("reservationsPolicyBundle — party size validation", () => {
  it("REFUSE reservation.create with partySize=0", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 0,
      }),
      baseState(),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.party_size.invalid")
  })

  it("REFUSE reservation.create with non-integer partySize", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 2.5,
      }),
      baseState(),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.party_size.invalid")
  })

  it("EXECUTE reservation.waitlist.join with valid partySize", () => {
    const decision = adjudicate(
      env("reservation.waitlist.join", {
        timeSlotId: "ts-1",
        partySize: 4,
      }),
      baseState(),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Business: blocked customer ──────────────────────────────────────────

describe("reservationsPolicyBundle — blocked customer", () => {
  it("REFUSE reservation.create from a blocked customer", () => {
    const decision = adjudicate(
      env("reservation.create", {
        timeSlotId: "ts-1",
        partySize: 2,
      }),
      baseState({
        customer: { id: "c-1", blocked: true, noShowRate: 0 },
      }),
      reservationsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("reservation.customer.blocked")
  })
})

// ── Default-deny invariant ──────────────────────────────────────────────

describe("reservationsPolicyBundle — default-deny invariant", () => {
  it("policy.default is REFUSE (fail-safe — master plan #4)", () => {
    expect(reservationsPolicyBundle.default).toBe("REFUSE")
  })

  it("reservationsPack.policy.default mirrors the bundle default", () => {
    expect(reservationsPack.policy.default).toBe("REFUSE")
  })
})

// ── PackV0 shape ────────────────────────────────────────────────────────

describe("reservationsPack — PackV0 shape", () => {
  it("declares v0 contract", () => {
    expect(reservationsPack.contract).toBe("v0")
  })

  it("id matches the org convention", () => {
    expect(reservationsPack.id).toBe("ibatexas/pack-reservations")
  })

  it("version is 1.0.0 (first stable release of pack-reservations)", () => {
    expect(reservationsPack.version).toBe("1.0.0")
  })

  it("declares non-empty unique intents", () => {
    expect(reservationsPack.intents.length).toBeGreaterThan(0)
    const unique = new Set(reservationsPack.intents)
    expect(unique.size).toBe(reservationsPack.intents.length)
  })

  it("[W2/P1-F] declares an empty signals array (slot.released removed — no publisher existed)", () => {
    // Per decisions-log §D9: the slot.released signal was removed because
    // no wire publisher existed; parked reservation.modify envelopes
    // silently TTL'd. Pack now has zero DEFER signals.
    expect(reservationsPack.signals).toEqual([])
  })

  it("planner returns a Plan with read-only tools and allowed intents", () => {
    const plan = reservationsPack.planner.plan(baseState(), {
      channel: "whatsapp",
      customerId: "c-1",
      staffId: null,
    })
    expect(plan.visibleReadTools.length).toBeGreaterThan(0)
    expect(plan.allowedIntents.length).toBeGreaterThan(0)
    // No MUTATING tool ever leaks into visibleReadTools.
    for (const t of plan.visibleReadTools) {
      expect(["check_availability", "get_my_reservations"]).toContain(t)
    }
  })

  it("planner exposes staff transitions only when staffId is present", () => {
    const customerPlan = reservationsPack.planner.plan(baseState(), {
      channel: "whatsapp",
      customerId: "c-1",
      staffId: null,
    })
    expect(customerPlan.allowedIntents).not.toContain("reservation.checkin")

    const staffPlan = reservationsPack.planner.plan(
      baseState({ staffId: "s-1", channel: "staff" }),
      { channel: "staff", customerId: null, staffId: "s-1" },
    )
    expect(staffPlan.allowedIntents).toContain("reservation.checkin")
    expect(staffPlan.allowedIntents).toContain("reservation.complete")
  })
})

// ── Rehydrator ──────────────────────────────────────────────────────────

describe("rehydrateReservationState", () => {
  it("returns a default state for malformed input", () => {
    const out = reservationsPack.rehydrateState?.(null)
    expect(out).toBeDefined()
    expect(out!.ctx.customerId).toBeNull()
  })

  it("promotes ISO-string Date fields back to Date", () => {
    const raw = {
      ctx: {
        channel: "web",
        customerId: "c-1",
        staffId: null,
        now: "2026-05-22T12:00:00.000Z",
        slot: {
          timeSlotId: "ts-1",
          startAt: "2026-05-22T20:00:00.000Z",
          maxCovers: 40,
          reservedCovers: 10,
        },
      },
    }
    const out = reservationsPack.rehydrateState?.(raw)
    expect(out?.ctx.now).toBeInstanceOf(Date)
    expect(out?.ctx.slot?.startAt).toBeInstanceOf(Date)
  })
})
