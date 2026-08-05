// bkl285-reservation-create-routing.e2e.test.ts — BKL-285 at the REAL customer
// turn seam.
//
// ── WHAT THIS PINS, AND WHY THE TICKET'S OWN MECHANISM NEEDED CORRECTING ─────
//
// The registered defect: "reserva uma mesa para 4 pessoas às 20h" — a booking
// IMPERATIVE — fired RESERVATION_STATUS_Q, because the reservation read anchor
// (`reserv`) IS the create verb. BKL-217 closed cancel/modify through the shared
// mutation net; create could never ride that net, so it stayed open.
//
// The ticket described the harm as "the booking mutation is SILENTLY DROPPED (no
// model call, no proposed intent)". Traced at this seam, that is NOT the
// mechanism, and the real one is worse. `handleTurn` runs PLAN → SUBMIT →
// INVESTIGATE → CLAIMS-VALIDATE → ACT → SYNTHESIZE, and `dispatchDecision` takes
// no claims argument at all: nothing downstream of the span classifier can stop an
// extraction, an adjudication, or an execution. What the read span actually
// changes is the REPLY. `claims-render-precedence.ts` rule 3 (`validated_render`)
// sits deliberately ABOVE rule 3b, so a VALIDATED read claim on a mixed read+act
// turn OVERWRITES the action reply — and because INVESTIGATE runs BEFORE ACT, the
// text that wins is a PRE-MUTATION read.
//
// So the measured pre-fix behaviour of this exact turn is:
//   · `reservation.create` is minted, adjudicated EXECUTE, and the table IS booked;
//   · the customer is told "O status da sua reserva é: confirmada para 2 pessoas
//     em 03/08 às 19:30" — the stale status of a DIFFERENT, pre-existing booking;
//   · the confirmation for the reservation they just made never reaches them.
// The customer believes they booked — for the wrong night, at the wrong size — and
// the booking they actually made is invisible to them. That is the harm class this
// file pins, and it is why the assertions below are on the REPLY and the ENVELOPE
// together: either alone passes on the defect.
//
// ── DIRECTIONAL BY CONSTRUCTION ─────────────────────────────────────────────
//
// Revert the `hasReservationCreateImperative` arm of the gate in
// required-claim-decomposer.ts and the create case goes red on the exact string
// above, while the read cases stay green. Revert-to-red was run per direction.
//
// ── SCOPE BOUNDARY, STATED PLAINLY ──────────────────────────────────────────
//
// This proves the ROUTE and the ENVELOPE. It does NOT prove production slot
// resolution: the availability lookup (`checkAvailability`), the advisory
// `timeSlot.findUnique` projection and the reservation WRITE are all faked here,
// so FE-D27's NL date/time grounding succeeds in this harness by construction.
// BKL-062 (NL time-slot injection) is a KNOWN OPEN gap and is untouched by this
// ticket — routing is the deliverable, slot resolution is not.
//
// Probes are FRESH pt-BR authored here; each was checked for exact-match absence
// from the 697-line in-repo utterance corpus.
//
// ── F-63: WHY THIS FILE FREEZES THE CLOCK ───────────────────────────────────
//
// As authored (2026-07-28) this file pinned `REQUESTED.date` to the literal
// "2026-08-05" — eight days ahead at the time. But the create path is not
// clock-free: `loadReservationCtx` (resolve-and-assemble.ts) stamps
// `ctx.now = new Date()` from the REAL clock, and the pack guard
// `requireSlotInFuture` (pack-reservations/src/policies.ts) REFUSEs when
// `slot.startAt <= now`. So on 2026-08-05 at 22:00 UTC this file's create case
// went red — `expected 'REFUSE' to be 'EXECUTE'`, basis
// `{reason: "slot_in_past", slotStartAt: "2026-08-05T20:00:00.000Z"}` — and
// from 2026-08-06 it would have been red in every timezone, forever. That is a
// wall-clock verdict masquerading as a routing verdict, and routing is this
// file's whole subject.
//
// The clock is therefore frozen for every case below. The guard is NOT
// bypassed: `ctx.slot` and `ctx.now` are both still populated, so
// `requireSlotInFuture` runs and evaluates on every create turn — it now
// simply evaluates against an instant we chose rather than one the runner
// happened to start at. (Its REFUSE arm is pinned deliberately, with an
// injected `now`, at pack-reservations/src/__tests__/reservations-pack.test.ts
// and .../conformance.test.ts; this file never pinned it and does not now.)
//
// FROZEN_NOW is timezone-robust BY ARITHMETIC, not by luck. `slotFromRow`
// builds `startAt` as `new Date("2026-08-05T20:00:00")` — no offset, so it is
// parsed in the RUNNER'S LOCAL ZONE. Across the full range of real UTC offsets
// (UTC-12 … UTC+14) that instant spans 2026-08-05T06:00Z … 2026-08-06T08:00Z.
// FROZEN_NOW sits at 2026-08-04T00:00Z — at least 30 hours before the earliest
// of those — so the slot is in the future in every zone the suite can run in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import { CLASSIFY_ONLY_READS_ENABLED_ENV } from "../claustrum/classify-only-reads.js";

/** The pre-existing booking the STATUS read answers from. Deliberately a
 *  DIFFERENT night, time and party size from the one being requested, so the two
 *  renders can never be confused for one another by any assertion below. */
const EXISTING = {
  id: "res-existing-1",
  statusLine: "confirmada para 2 pessoas em 03/08 às 19:30",
} as const;

/** The instant every case below runs at. See the F-63 note in the header for the
 *  timezone arithmetic that makes `REQUESTED` future-dated in every zone. */
const FROZEN_NOW = new Date("2026-08-04T00:00:00.000Z");

/** The booking the customer is ASKING for in the create case. */
const REQUESTED = {
  slotId: "ts-2000-05ago",
  date: "2026-08-05",
  time: "20:00",
  partySize: 4,
  newReservationId: "res-new-9",
} as const;

const { st } = vi.hoisted(() => ({ st: { availabilityCalls: 0, creates: 0 } }));

vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  return {
    ...actual,
    // Narrow overrides only — a flat factory would stub the other `@ibatexas/domain`
    // exports as `undefined` (the PR #248 vi.mock saga).
    createReservationService: () => ({
      // FE-D27's NL date/time grounding calls this; one slot ⇒ the resolver stamps
      // `timeSlotId` and the pack's slot guard can reach EXECUTE.
      checkAvailability: async () => {
        st.availabilityCalls += 1;
        return [{ timeSlotId: "ts-2000-05ago", startTime: "20:00" }];
      },
      listByCustomer: async () => ({ reservations: [] }),
      getById: async () => null,
      create: async () => {
        st.creates += 1;
        return {
          reservation: {
            id: "res-new-9",
            status: "CONFIRMED",
            partySize: 4,
            timeSlot: { id: "ts-2000-05ago", date: "2026-08-05", startTime: "20:00" },
          },
          tableLocation: null,
        };
      },
    }),
    // Only the tables this turn touches; anything else reaching for prisma in this
    // graph should fail loudly rather than silently hit a real DB.
    prisma: {
      timeSlot: {
        findUnique: async () => ({
          id: "ts-2000-05ago",
          date: new Date("2026-08-05T00:00:00.000Z"),
          startTime: "20:00",
          maxCovers: 20,
          reservedCovers: 0,
        }),
      },
      reservation: { findUnique: async () => null },
    },
  };
});

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  // Dynamic import: a `vi.mock` factory is hoisted above this file's static imports,
  // so it cannot close over one. The builder is type-only against turn-reads.js, so
  // this drags no infrastructure into the factory (see the helper's header).
  const { buildTriadReadBackend } = await import("./helpers/triad-backend-builder.js");
  return {
    ...actual,
    // Every read NOT declared below defaults to a `notUsed` thrower naming itself, so
    // an unexpected read fails loudly instead of returning a fabricated value.
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
        readScheduleOverride: async () => null,
        readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHoliday: async () => null,
        readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        // The owner-scoped reservation read the STATUS span resolves from. Its
        // `statusLine` is the enriched scalar the renderer fills its slot with
        // (BKL-185), so an assertion on that string is an assertion that the READ
        // render — and nothing else — took the turn.
        readReservation: async (reservationId) => ({
          reservationId,
          status: "CONFIRMED",
          partySize: 2,
          statusLine: EXISTING.statusLine,
        }),
        listActiveOrderIds: async () => [],
        // The customer ALREADY holds a booking — which is what makes the pre-fix
        // reply a confident, validated answer about the wrong reservation rather
        // than a harmless "not found".
        listActiveReservationIds: async () => [EXISTING.id],
        countActivePayments: async () => 0,
      }),
  };
});

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulCustomerSession,
  runCustomerTurn,
} = await import("./customer-e2e-harness.js");

/** The responder's own words. Armed so it can never be mistaken for either the
 *  status render or the kernel's booking confirmation. */
const MODEL_DRAFT = "Certo, já cuidei disso pra você.";

/**
 * A model that behaves like a 4B which PARSED THE TURN CORRECTLY: on a booking
 * request it emits `express_intent(reservation.create)`; when `emitIntent` is
 * false it is a plain responder (the read turns).
 *
 * The intent leg is scripted rather than gated on the utterance because the
 * planner's extraction call runs on BOTH routes — that is exactly what the trace
 * established, and it is why "the envelope was minted" alone cannot be the
 * directional assertion here. The REPLY is.
 */
function bookingModel(emitIntent: boolean): ModelProvider {
  let fired = false;
  return {
    complete: vi.fn(async (req: CompletionRequest): Promise<Completion> => {
      const toolNames = (req.tools ?? []).map((t) => t.name);
      const base = {
        model: "mock",
        stopReason: "end_turn",
        inputTokens: 5,
        outputTokens: 4,
      } as const;
      if (emitIntent && toolNames.includes("express_intent") && !fired) {
        fired = true;
        return {
          ...base,
          text: "",
          toolCalls: [
            {
              id: "tu-bkl285",
              name: "express_intent",
              input: {
                capability: "reservation.create",
                // The NL date/time pair FE-D27 grounds — the shape a pure-chat
                // booking really produces (no prior check_availability read).
                payload: {
                  partySize: REQUESTED.partySize,
                  date: REQUESTED.date,
                  time: REQUESTED.time,
                },
              },
            },
          ],
        };
      }
      return { ...base, text: MODEL_DRAFT, toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

let seq = 0;

async function drive(text: string, opts: { emitIntent: boolean }) {
  seq += 1;
  const sink = makeCapturingAuditSink();
  const harness = composeCustomerConductor({
    model: bookingModel(opts.emitIntent),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink }),
    withClaims: true,
    // Production's responder. Without it the claims-render precedence that carries
    // this whole defect is not exercised.
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: `cust-bkl285-${seq}`,
    conversationId: `conv-bkl285-${seq}`,
    text,
  });
  return { out, sink };
}

beforeEach(() => {
  // Only `Date` is faked. Faking timers wholesale stalls this harness — the turn
  // is driven through real awaits (the dashboard.test.ts precedent for the same
  // reason).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  // ON, because the ROUTE is what this file is about — and it is the dev/ratified
  // setting (.env.example: "Slice-A ratification: ON in dev").
  process.env[CLASSIFY_ONLY_READS_ENABLED_ENV] = "true";
  st.availabilityCalls = 0;
  st.creates = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BKL-285 e2e — a booking IMPERATIVE reaches reservation.create and is REPORTED", () => {
  it("THE REGISTERED DEFECT: 'reserva uma mesa para 4 pessoas às 20h' books, and the customer is told about THAT booking", async () => {
    const { out, sink } = await drive("reserva uma mesa para 4 pessoas às 20h", {
      emitIntent: true,
    });

    // ── THE ENVELOPE ────────────────────────────────────────────────────────
    // The booking reached the kernel, was adjudicated, and executed. Asserted on
    // the audited envelope rather than a spy count, so a wrong kind cannot pass.
    const minted = sink.byKind("reservation.create");
    expect(minted).toHaveLength(1);
    expect(minted[0]!.decision.kind).toBe("EXECUTE");
    expect(out.decision.kind).toBe("EXECUTE");
    // FE-D27's NL date/time pair was grounded to a REAL slot id before the guard
    // ran — the payload the kernel adjudicated is the resolved one, not the raw
    // model output.
    expect(minted[0]!.envelope.payload).toMatchObject({
      timeSlotId: REQUESTED.slotId,
      partySize: REQUESTED.partySize,
    });
    expect(st.availabilityCalls).toBe(1);
    expect(st.creates).toBe(1);
    expect(out.acted).toMatchObject({
      kind: "executed",
      result: { reservationId: REQUESTED.newReservationId, confirmed: true },
    });

    // ── THE ROUTE, VIA THE REPLY — THE DIRECTIONAL HALF ─────────────────────
    // Pre-fix this turn ALSO minted and executed the envelope, so every assertion
    // above passed on the defect. What did NOT pass is this: the read span fired,
    // RESERVATION_STATUS validated off the customer's OTHER booking, and rule 3
    // `validated_render` replaced the action reply with that stale read.
    expect(out.response).not.toContain(EXISTING.statusLine);
    expect(out.response).not.toMatch(/status da sua reserva/i);
    // …named down to its scalars, so a reworded status template still fails.
    expect(out.response).not.toContain("03/08");
    expect(out.response).not.toContain("19:30");
  });

  it("THE CONTROL — the three read phrasings #454 pins still ride the deterministic read", async () => {
    // Without this, the case above would pass on a family that simply broke: the
    // fix must remove the read from BOOKING turns only, never from BOOKING
    // QUESTIONS. Each of these must still be answered from the validated claim.
    for (const text of [
      "minha mesa está confirmada?",
      "minha reserva está confirmada?",
      "qual minha reserva?",
    ]) {
      const { out, sink } = await drive(text, { emitIntent: false });
      expect(out.response, text).toContain(EXISTING.statusLine);
      // …and nothing was booked on a question.
      expect(sink.byKind("reservation.create"), text).toHaveLength(0);
      expect(st.creates, text).toBe(0);
    }
  });

  // BKL-270 — RESERVATION_STATUS's ratified posture is `answer-anyway`: a customer
  // who names a dietary condition still gets their reservation status, and the diet
  // span is never dropped. This ticket moves WHICH turns take the read route, so
  // that posture is OBSERVED here rather than assumed (the BKL-270 rule).
  it("BKL-270 posture is untouched — a diet-qualified STATUS ask still gets the status", async () => {
    const { out } = await drive("sou diabético, minha mesa está confirmada?", {
      emitIntent: false,
    });
    expect(out.response).toContain(EXISTING.statusLine);
  });
});
