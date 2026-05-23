/**
 * @ibatexas/pack-reservations — conformance test.
 *
 * Two-part:
 *
 *   1. Corpus of 25+ envelope+state fixtures covering EXECUTE,
 *      REFUSE, DEFER, REQUEST_CONFIRMATION, and ESCALATE outcomes
 *      across the Pack's 8 intent kinds. Each fixture asserts the
 *      expected Decision shape against `reservationsPack.policy`.
 *
 *   2. Kernel-invariant suite — `runConformance(reservationsPack)`
 *      from `@adjudicate/conformance` verifies taint protection,
 *      replay determinism, intent-hash determinism, basis-vocabulary
 *      purity, guard ordering, and default polarity hold for the Pack.
 *
 * Note REWRITE is intentionally not exercised — the reservation domain
 * has no clamping primitive (party size is bounded by slot capacity
 * via REFUSE, not REWRITE). Five of six decision outcomes appear in
 * this corpus; the sixth (REWRITE) is appropriately absent here.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { runConformance } from "@adjudicate/conformance"
import {
  reservationsPack,
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
        startAt: new Date("2026-05-22T20:00:00.000Z"),
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

// ── Corpus ──────────────────────────────────────────────────────────────

type Fixture = {
  readonly name: string
  readonly envelope: IntentEnvelope<ReservationIntentKind, ReservationPayload>
  readonly state: ReservationState
  readonly expect: {
    readonly kind:
      | "EXECUTE"
      | "REFUSE"
      | "DEFER"
      | "REWRITE"
      | "REQUEST_CONFIRMATION"
      | "ESCALATE"
    readonly refusalCode?: string
    readonly signal?: string
    readonly escalateTo?: "human" | "supervisor"
  }
}

const corpus: ReadonlyArray<Fixture> = [
  // ── EXECUTE (8 cases) ────────────────────────────────────────────────
  {
    name: "EXECUTE: reservation.create with slot capacity and small party",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 2,
    }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: reservation.create with low no-show rate (under threshold)",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 4,
    }),
    state: baseState({
      customer: { id: "c-1", noShowRate: 0.1 },
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: reservation.modify with new slot having capacity",
    envelope: env("reservation.modify", {
      reservationId: "r-1",
      newTimeSlotId: "ts-2",
      newPartySize: 3,
    }),
    state: baseState({
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
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: reservation.cancel well before the slot",
    envelope: env("reservation.cancel", { reservationId: "r-1" }),
    state: baseState({
      now: new Date("2026-05-21T12:00:00.000Z"),
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
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: reservation.waitlist.join on a full slot",
    envelope: env("reservation.waitlist.join", {
      timeSlotId: "ts-1",
      partySize: 4,
    }),
    state: baseState({
      slot: {
        timeSlotId: "ts-1",
        startAt: new Date("2026-05-22T20:00:00.000Z"),
        maxCovers: 40,
        reservedCovers: 40,
      },
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: TRUSTED reservation.no_show.mark (system actor)",
    envelope: env(
      "reservation.no_show.mark",
      { reservationId: "r-1" },
      "TRUSTED",
    ),
    state: baseState({
      reservation: {
        id: "r-1",
        status: "confirmed",
        partySize: 2,
        timeSlotId: "ts-1",
      },
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: TRUSTED reservation.waitlist.notify (system actor)",
    envelope: env(
      "reservation.waitlist.notify",
      { waitlistId: "w-1" },
      "TRUSTED",
    ),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: staff reservation.checkin on confirmed booking",
    envelope: env(
      "reservation.checkin",
      { reservationId: "r-1" },
      "TRUSTED",
    ),
    state: baseState({
      channel: "staff",
      staffId: "staff-1",
      customerId: null,
      reservation: {
        id: "r-1",
        status: "confirmed",
        partySize: 2,
        timeSlotId: "ts-1",
      },
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: staff reservation.complete on seated booking",
    envelope: env(
      "reservation.complete",
      { reservationId: "r-1" },
      "TRUSTED",
    ),
    state: baseState({
      channel: "staff",
      staffId: "staff-1",
      customerId: null,
      reservation: {
        id: "r-1",
        status: "seated",
        partySize: 2,
        timeSlotId: "ts-1",
      },
    }),
    expect: { kind: "EXECUTE" },
  },

  // ── REFUSE (10 cases) ────────────────────────────────────────────────
  {
    name: "REFUSE: reservation.create with no authenticated customer",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 2,
    }),
    state: baseState({ customerId: null, channel: "web" }),
    expect: { kind: "REFUSE", refusalCode: "auth.required" },
  },
  {
    name: "REFUSE: reservation.create with slot at capacity",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 4,
    }),
    state: baseState({
      slot: {
        timeSlotId: "ts-1",
        startAt: new Date("2026-05-22T20:00:00.000Z"),
        maxCovers: 40,
        reservedCovers: 40,
      },
    }),
    expect: { kind: "REFUSE", refusalCode: "reservation.slot.full" },
  },
  {
    name: "REFUSE: reservation.create with slot in the past",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 2,
    }),
    state: baseState({
      now: new Date("2026-05-22T22:00:00.000Z"),
    }),
    expect: { kind: "REFUSE", refusalCode: "reservation.slot.in_past" },
  },
  {
    name: "REFUSE: reservation.create with partySize=0",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 0,
    }),
    state: baseState(),
    expect: { kind: "REFUSE", refusalCode: "reservation.party_size.invalid" },
  },
  {
    name: "REFUSE: reservation.create from blocked customer",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 2,
    }),
    state: baseState({
      customer: { id: "c-1", blocked: true, noShowRate: 0 },
    }),
    expect: { kind: "REFUSE", refusalCode: "reservation.customer.blocked" },
  },
  {
    name: "REFUSE: reservation.modify without reservation snapshot",
    envelope: env("reservation.modify", {
      reservationId: "r-1",
      newPartySize: 4,
    }),
    state: baseState({ reservation: null }),
    expect: { kind: "REFUSE", refusalCode: "reservation.not_found" },
  },
  {
    name: "REFUSE: reservation.modify on terminal (cancelled) reservation",
    envelope: env("reservation.modify", {
      reservationId: "r-1",
      newPartySize: 4,
    }),
    state: baseState({
      reservation: {
        id: "r-1",
        status: "cancelled",
        partySize: 2,
        timeSlotId: "ts-1",
      },
    }),
    expect: { kind: "REFUSE", refusalCode: "reservation.not_modifiable" },
  },
  {
    name: "REFUSE: reservation.cancel on no-show (terminal) reservation",
    envelope: env("reservation.cancel", { reservationId: "r-1" }),
    state: baseState({
      reservation: {
        id: "r-1",
        status: "no_show",
        partySize: 2,
        timeSlotId: "ts-1",
      },
    }),
    expect: { kind: "REFUSE", refusalCode: "reservation.not_cancellable" },
  },
  {
    name: "REFUSE: UNTRUSTED reservation.no_show.mark (taint gate)",
    envelope: env(
      "reservation.no_show.mark",
      { reservationId: "r-1" },
      "UNTRUSTED",
    ),
    state: baseState({
      reservation: {
        id: "r-1",
        status: "confirmed",
        partySize: 2,
        timeSlotId: "ts-1",
      },
    }),
    expect: { kind: "REFUSE" },
  },
  {
    name: "REFUSE: UNTRUSTED reservation.waitlist.notify (taint gate)",
    envelope: env(
      "reservation.waitlist.notify",
      { waitlistId: "w-1" },
      "UNTRUSTED",
    ),
    state: baseState(),
    expect: { kind: "REFUSE" },
  },
  {
    name: "REFUSE: reservation.checkin without staffId (staff-only auth)",
    envelope: env(
      "reservation.checkin",
      { reservationId: "r-1" },
      "TRUSTED",
    ),
    state: baseState({
      staffId: null,
      reservation: {
        id: "r-1",
        status: "confirmed",
        partySize: 2,
        timeSlotId: "ts-1",
      },
    }),
    expect: { kind: "REFUSE", refusalCode: "reservation.staff_only" },
  },

  // ── DEFER (2 cases) ──────────────────────────────────────────────────
  {
    name: "DEFER: reservation.modify on a full new slot",
    envelope: env("reservation.modify", {
      reservationId: "r-1",
      newTimeSlotId: "ts-2",
    }),
    state: baseState({
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
    expect: { kind: "DEFER", signal: "slot.released" },
  },
  {
    name: "DEFER: reservation.modify on an over-capacity new slot",
    envelope: env("reservation.modify", {
      reservationId: "r-1",
      newTimeSlotId: "ts-2",
      newPartySize: 6,
    }),
    state: baseState({
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
    expect: { kind: "DEFER", signal: "slot.released" },
  },

  // ── REQUEST_CONFIRMATION (3 cases) ───────────────────────────────────
  {
    name: "REQUEST_CONFIRMATION: cancel 30 minutes before slot",
    envelope: env("reservation.cancel", { reservationId: "r-1" }),
    state: baseState({
      now: new Date("2026-05-22T19:30:00.000Z"),
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
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: cancel exactly 1 hour before slot",
    envelope: env("reservation.cancel", { reservationId: "r-1" }),
    state: baseState({
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
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: cancel 15 minutes before slot",
    envelope: env("reservation.cancel", { reservationId: "r-1" }),
    state: baseState({
      now: new Date("2026-05-22T19:45:00.000Z"),
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
    expect: { kind: "REQUEST_CONFIRMATION" },
  },

  // ── ESCALATE (3 cases) ───────────────────────────────────────────────
  {
    name: "ESCALATE: reservation.create with 50% no-show rate",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 2,
    }),
    state: baseState({
      customer: { id: "c-1", noShowRate: 0.5 },
    }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
  {
    name: "ESCALATE: reservation.create with 90% no-show rate (clearly excessive)",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 4,
    }),
    state: baseState({
      customer: { id: "c-1", noShowRate: 0.9 },
    }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
  {
    name: "ESCALATE: reservation.create with no-show rate just above threshold",
    envelope: env("reservation.create", {
      timeSlotId: "ts-1",
      partySize: 2,
    }),
    state: baseState({
      customer: { id: "c-1", noShowRate: 0.31 },
    }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
]

describe("reservationsPack — corpus (25+ cases across 5 decision kinds)", () => {
  it("corpus is at least 25 cases (acceptance criterion)", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(25)
  })

  for (const fixture of corpus) {
    it(fixture.name, () => {
      const decision = adjudicate(
        fixture.envelope,
        fixture.state,
        reservationsPack.policy,
      )
      expect(decision.kind).toBe(fixture.expect.kind)
      if (fixture.expect.refusalCode && decision.kind === "REFUSE") {
        expect(decision.refusal.code).toBe(fixture.expect.refusalCode)
      }
      if (fixture.expect.signal && decision.kind === "DEFER") {
        expect(decision.signal).toBe(fixture.expect.signal)
      }
      if (fixture.expect.escalateTo && decision.kind === "ESCALATE") {
        expect(decision.to).toBe(fixture.expect.escalateTo)
      }
    })
  }
})

// ── Kernel-invariant suite ──────────────────────────────────────────────

describe("reservationsPack — kernel invariants via runConformance()", () => {
  it("runConformance returns zero failures", () => {
    const report = runConformance(reservationsPack)
    if (!report.passed) {
      for (const r of report.results) {
        if (!r.passed) console.error(`[${r.id}] ${r.name}: ${r.details}`)
      }
    }
    expect(report.passed).toBe(true)
    expect(report.summary.failed).toBe(0)
  })

  it("policy default is REFUSE (default-polarity / bypass-detection)", () => {
    // Mirrors AC-006 (default-polarity) from @adjudicate/conformance —
    // also asserted here so the bypass-detection invariant is
    // surfaced explicitly in the Pack's own test surface (task spec
    // acceptance criterion).
    expect(reservationsPack.policy.default).toBe("REFUSE")
  })
})
